require("dotenv").config();
const { App } = require("@slack/bolt");
const { DateTime } = require("luxon");
const cron = require("node-cron");
const { MongoClient } = require("mongodb");

const mongoUri = process.env.MONGO_URI;
const dbName = "attendanceDB";
let db;

async function connectToMongoDB() {
  console.log("connectToMongoDB");

  try {
    const client = new MongoClient(mongoUri);
    await client.connect();
    db = client.db(dbName);
    console.log("Connected to MongoDB");
  } catch (error) {
    console.error("Error connecting to MongoDB", error);
  }
}

connectToMongoDB();

const slackAppToken = process.env.SLACK_APP_TOKEN;
const slackBotToken = process.env.SLACK_BOT_TOKEN;

const app = new App({
  token: slackBotToken,
  appToken: slackAppToken,
  socketMode: true,
});

let attendanceRecord = {};
let originalMessageTs = null;

async function saveAttendanceRecordToDB(week) {
  const collection = db.collection("attendanceRecords");
  await collection.updateOne(
    { week: week },
    { $set: { records: attendanceRecord[week] } },
    { upsert: true }
  );
}

async function loadAttendanceRecordFromDB(week) {
  const collection = db.collection("attendanceRecords");
  const record = await collection.findOne({ week: week });

  if (record) {
    attendanceRecord[week] = record.records;
  } else {
    attendanceRecord[week] = null;
  }
}

async function initializeWeekRecord(channelId, botUserId) {
  const currentDate = DateTime.local();
  const currentWeek = `Week ${currentDate.weekNumber}`;
  attendanceRecord[currentWeek] = {};

  const membersResponse = await app.client.conversations.members({
    token: slackBotToken,
    channel: channelId,
  });

  const participants = membersResponse.members.filter((id) => id !== botUserId);

  for (const participant of participants) {
    const userInfo = await app.client.users.info({ user: participant });
    const userName = userInfo.user.real_name;
    attendanceRecord[currentWeek][userName] = ["❌", "❌", "❌", "❌", "❌"];
  }

  await saveAttendanceRecordToDB(currentWeek);
}

async function startDailyChallenge() {
  const currentDate = DateTime.local().setZone("Asia/Seoul");
  const currentWeek = `Week ${currentDate.weekNumber}`;

  await loadAttendanceRecordFromDB(currentWeek);

  if (!attendanceRecord[currentWeek]) {
    console.log("No existing attendance record found. Initializing a new one.");
    const channelId = "C07KE8YLERZ";
    const botUserId = "U07GELRJTNY";
    await initializeWeekRecord(channelId, botUserId);
  }

  const month = currentDate.month;
  const week =
    currentDate.weekNumber - currentDate.startOf("month").weekNumber + 1;
  const day = currentDate.setLocale("ko").toFormat("cccc");

  let messageText = `${month}월 ${week}주차 ${day} 인증 기록\n`;

  const participants = Object.keys(attendanceRecord[currentWeek]);

  participants.forEach((userName) => {
    messageText += `${userName} : ${attendanceRecord[currentWeek][
      userName
    ].join("")}\n`;
  });

  const result = await app.client.chat.postMessage({
    channel: "C07KE8YLERZ",
    text: messageText,
  });

  originalMessageTs = result.ts;
}

cron.schedule("1 0 * * *", async () => {
  const currentDate = DateTime.local().setZone("Asia/Seoul");

  if (currentDate.weekday === 1) {
    // 월요일
    const channelId = "C07KE8YLERZ";
    const botUserId = "U07GELRJTNY";
    await initializeWeekRecord(channelId, botUserId); // 새로운 주의 기록을 초기화
  } else if (currentDate.weekday >= 2 && currentDate.weekday <= 5) {
    // 화요일 ~ 금요일
    await startDailyChallenge(); // 기존 주의 기록을 이어서 진행
  }
});

app.message("챌린지 업데이트", async ({ message, say }) => {
  const currentDate = DateTime.local().setZone("Asia/Seoul");
  const currentWeek = `Week ${currentDate.weekNumber}`;

  await loadAttendanceRecordFromDB(currentWeek);

  if (!attendanceRecord[currentWeek]) {
    await say("현재 주차의 챌린지 기록이 없습니다.");
    return;
  }

  const month = currentDate.month;
  const week =
    currentDate.weekNumber - currentDate.startOf("month").weekNumber + 1;
  const day = currentDate.setLocale("ko").toFormat("cccc");

  let messageText = `${month}월 ${week}주차 ${day} 인증 기록\n`;

  const participants = Object.keys(attendanceRecord[currentWeek]);

  participants.forEach((userName) => {
    messageText += `${userName} : ${attendanceRecord[currentWeek][
      userName
    ].join("")}\n`;
  });

  try {
    const result = await app.client.chat.postMessage({
      channel: "C07KE8YLERZ",
      text: messageText,
    });

    originalMessageTs = result.ts;
  } catch (error) {
    console.error("챌린지 메시지 생성 중 오류 발생:", error);
    await say("챌린지 메시지 생성 중 오류가 발생했습니다.");
  }
});
app.event("app_mention", async ({ event, say, client }) => {
  const currentDate = DateTime.local().setZone("Asia/Seoul");

  if (currentDate.hour >= 23 && currentDate.minute >= 59) {
    await say({
      text: "오늘 챌린지 인증 마감 되었습니다.",
      thread_ts: event.ts,
    });
    return;
  }

  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const hasLink = urlRegex.test(event.text);

  if (!hasLink) {
    await say({
      text: "인증이 실패했습니다. 쓰레드 링크를 포함해야 합니다.",
      thread_ts: event.ts,
    });
    return;
  }

  const userId = event.user;
  const userInfo = await client.users.info({ user: userId });
  const userName = userInfo.user.real_name;

  const currentWeek = `Week ${currentDate.weekNumber}`;
  const month = currentDate.month;
  const week =
    currentDate.weekNumber - currentDate.startOf("month").weekNumber + 1;
  const day = currentDate.setLocale("ko").toFormat("cccc");

  await loadAttendanceRecordFromDB(currentWeek);

  if (!attendanceRecord[currentWeek]) {
    await say({
      text: "챌린지가 아직 시작되지 않았습니다. '챌린지 시작'을 입력하세요.",
      thread_ts: event.ts,
    });
    return;
  }

  const participants = Object.keys(attendanceRecord[currentWeek]);

  if (!participants.includes(userName)) {
    await say({
      text: "참가자 이름을 확인해 주세요.",
      thread_ts: event.ts,
    });
    return;
  }

  const today = currentDate.weekday - 1;

  // 이미 오늘 인증을 완료했는지 확인
  if (attendanceRecord[currentWeek][userName][today] === "✅") {
    await say({
      text: "오늘 인증을 이미 완료했습니다.",
      thread_ts: event.ts,
    });
    return;
  }

  for (let i = 0; i <= today; i++) {
    if (attendanceRecord[currentWeek][userName][i] === "❌") {
      attendanceRecord[currentWeek][userName][i] = "✅";
      break;
    }
  }

  let messageText = `${month}월 ${week}주차 ${day} 인증 기록\n`;
  participants.forEach((name) => {
    messageText += `${name} : ${attendanceRecord[currentWeek][name].join(
      ""
    )}\n`;
  });

  await client.chat.update({
    channel: event.channel,
    ts: originalMessageTs,
    text: messageText,
  });

  await client.reactions.add({
    channel: event.channel,
    name: "heart",
    timestamp: event.ts,
  });

  await saveAttendanceRecordToDB(currentWeek);
});

app.message("챌린지 삭제", async ({ message, say }) => {
  const currentDate = DateTime.local().setZone("Asia/Seoul");
  const currentWeek = `Week ${currentDate.weekNumber}`;
  const collection = db.collection("attendanceRecords");

  const result = await collection.deleteOne({ week: currentWeek });

  if (result.deletedCount > 0) {
    delete attendanceRecord[currentWeek];
    await say("현재 주차의 챌린지 기록이 삭제되었습니다.");
  } else {
    await say("삭제할 챌린지 기록이 없습니다.");
  }
});

(async () => {
  await app.start();
  console.log("⚡️ Slack Bolt app is running!");
})();
