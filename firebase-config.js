// 在 Firebase 控制台 → 项目设置 → 常规 → 你的应用 → SDK 设置和配置 里复制，替换下面的值。
// 这些值放在前端是正常的，真正保护数据的是 database.rules.json 里的安全规则。
export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  // 一定要有 databaseURL，在 Realtime Database 页面顶部能看到
  databaseURL: "https://YOUR_PROJECT-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "YOUR_PROJECT",
  appId: "YOUR_APP_ID",
};
