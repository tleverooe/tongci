# 同词相见

两到四个人各写一个词，没对上就从大家上一轮的词里继续联想，直到所有人写出同一个词。纯前端网页 + Firebase Realtime Database，不需要自己的服务器。

## 文件

- `index.html` / `style.css` / `app.js`：网页本体
- `firebase-config.js`：填你自己的 Firebase 配置
- `database.rules.json`：数据库安全规则

## 配置 Firebase（免费 Spark 计划，不用绑卡）

1. 打开 https://console.firebase.google.com ，新建项目（Google Analytics 可以关掉）。
2. 左侧 **构建 → Realtime Database → 创建数据库**，位置选 **Singapore (asia-southeast1)**（离澳洲最近），以**锁定模式**启动。
3. 进入数据库的 **规则** 标签，把 `database.rules.json` 的内容整段粘进去，点发布。
4. 回到 **项目设置 → 常规 → 你的应用**，点 `</>` 添加一个 Web 应用（不用勾 Hosting），把给出的配置复制到 `firebase-config.js`。确认里面有 `databaseURL`，没有的话去 Realtime Database 页面顶部复制那串地址补上。

## 本地运行

ES module 不能直接双击用 `file://` 打开，需要起一个本地服务器：

```bash
cd tongci
python3 -m http.server 8000
# 或者 npx serve .
```

然后打开 http://localhost:8000 。自己测试多人可以开两个不同的浏览器（或一个普通窗口 + 一个无痕窗口），因为玩家身份存在 localStorage 里，同一个浏览器的两个标签页会被当成同一个人。

## 部署到 GitHub Pages

把这个文件夹推到仓库，Settings → Pages → 选分支和目录即可。朋友打开 `https://你的用户名.github.io/仓库名/?room=房间码` 会直接进房间（第一次需要先填昵称）。

## 规则说明

- 只有房间里所有在线的人写出同一个词才算"相见"；比较时忽略大小写、空格和标点。
- 第 2 轮起会显示上一轮所有人的词。房主可以在房间设置里选择能否重复用之前出现过的词（默认允许）。
- 时间到了没提交算超时；输入框里已经打好但没点提交的词会被自动交上去。
- 游戏中途有人掉线，会被标记为离线，不再要求他提交，剩下的人照常玩。大厅里掉线就直接退出房间。
- 房主离开后，最早进房间且在线的人接任房主。

## 已知限制

- 所有人都能读房间数据，懂开发者工具的人可以在揭晓前偷看别人的词。朋友之间玩问题不大；要防作弊需要加 Cloud Functions 由服务器负责揭晓（需要升级 Blaze 计划）。
- 旧房间不会自动删除。数据量很小，免费额度 1 GB 够用很久，想清理可以在控制台手动删 `rooms`。
- Firebase 在中国大陆无法访问。
