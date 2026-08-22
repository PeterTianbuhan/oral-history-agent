# My Life / 我的一生

一个本地优先、开源的口述记忆助手。你只需要说话或打字；Agent 在后台维护人生时间线、人物、地点、事实与可持续的对话。

它最初是为我的爷爷做的，但不限定年龄，也不试图把回忆做成一门生意。目标只是把“记录一生”的门槛降到开口说话。

![首次连接记忆助手的移动端界面](docs/onboarding-browser-check-render.png)

## 现在能做什么

- 打开就是持续保存的对话，Agent 每轮先给一条短回应，再继续整理
- 语音转录实时进入可编辑输入框；发送当前一段不会结束整场录音
- 自然语言时间块组成线性时间线；人物和地点是可展开卡片
- 已形成内容可以直接修改；用户的明确要求与亲手编辑始终优先
- 原始录音、原始转录、修正文字和形成内容彼此分开
- Agent 主动选择关键词检索；搜不到可以换词继续搜
- 长对话会 compact 模型上下文，但不会删除用户可见的完整对话
- Android 和 iPhone 共用 React / Capacitor 界面，各自使用原生录音能力
- 简体中文、繁體中文与 English 界面
- 无中继服务器，无内置 API Key；每个人在自己的设备上填写自己的 Key

## 模型与语音服务

记忆 Agent 支持四类 OpenAI 兼容服务：

- **OpenRouter（推荐）**：默认模型是 `openrouter/auto`，也可填写任意 OpenRouter 模型 ID
- **OpenAI**
- **阿里云百炼**：默认 `deepseek-v4-flash-0731`
- **自定义 OpenAI-compatible endpoint**

语音识别是独立配置，不由 OpenRouter 提供：

- iPhone：Apple Speech，可用时优先设备端识别
- Android：可选阿里云 `qwen3-asr-flash-realtime`
- 不配置语音服务也可以只用文字；录音仍可作为原始证据保留

所有请求都从设备直接发往用户选择的服务。项目没有自己的 API 中继，也不会收到用户的 Key。

## 界面下面真实存在什么

这不是把整段人生塞进一个聊天上下文。长期状态分成四层：

1. **Evidence**：原始转录、本人修正文字、录音 URI、时长、采集时间与来源；WAV 本体单独保存在设备上。
2. **Formed memory**：有顺序的 timeline、人物卡片、地点卡片与事实库。
3. **Agent jobs**：每个输入片段对应一个可恢复、幂等的任务，记录 `pending / running / applied / failed`、尝试次数和错误。
4. **Conversation**：用户能看到的完整对话，外加仅供模型续聊的 compact 摘要游标。

模型会话本身不是长期记忆。每段输入触发一次 Pi Agent，完成后销毁；下一轮需要过去信息时，Agent 使用本地工具搜索和读取。

### Agent 工具

- `search_memory`：用一组字面关键词搜索时间线、人物、地点、事实和原话
- `read_memory`：按稳定 ID 读取当前准确内容与关联证据
- `read_timeline_window`：读取一个时间块前后的线性位置
- `apply_memory_patch`：原子新增、修改、移动、合并或删除形成内容
- `speak_to_narrator`：向对话界面发送用户能看到的消息，支持流式显示与一轮多条

### 哪些流程被强制

Agent 的分析与工具选择是自由的，没有“先时间线、再人物、再地点”的固定流水线。系统只强制可靠性护栏：

- 每轮先用 `speak_to_narrator` 接住用户一次；之后所有工具一起开放
- 改动现有内容前先搜索并精确读取目标
- 用户正在编辑时，Agent 工具调用挂起等待
- 一组 patch 要么全部通过校验，要么完全不落盘
- 同一片段只入队一次；运行中的任务在异常退出后恢复为待处理
- compact 只改变下轮模型上下文，不删可见历史或原始证据

角色提示位于 `prompts/`，确定性记忆引擎位于 `src/memory/`，Pi 执行与任务队列位于 `src/agent/`。

## 导出

四个页面的导出语义不同：

- **聊一聊**：完整备份。JSON 保存完整状态和录音 URI；在 Android / iPhone 分享时，系统会把 JSON 与所有 WAV 作为多个附件一起交给分享面板。录音字节不会被塞进 JSON 本身。
- **我的一生**：只导出时间线 Markdown
- **我认识的人**：只导出人物 Markdown
- **我去过的地方**：只导出地点 Markdown

后三种 Markdown 不包含录音、`audioUri`、Agent 队列或其他页面内容，因此文件很小。当前版本还没有“一键恢复完整备份”界面；卸载原生应用前请妥善保存完整备份的全部附件。

## 本地与隐私边界

原生客户端把完整记忆和录音保存在应用目录。API Key 在 Android 使用 Keystore 加密，在 iPhone 使用 Keychain；源码、APK/IPA 构建参数和仓库中都不包含 Key。

“本地优先”不等于“模型离线运行”。启用云端服务后：

- Android 实时转录会把正在讲述的音频分片发送给用户选择的 ASR 服务
- Agent 会把当前输入，以及它主动搜索并读取到的相关旧内容，发送给用户选择的模型服务
- 没有被 Agent 读取的其他记忆不会自动进入模型上下文

Web 开发预览把设置放在该浏览器 origin 的 `localStorage`，只适合本地调试；面向普通用户应使用原生客户端。

## 本机运行

需要 Node.js 22 或更高版本。

```bash
npm install
npm test
npm run dev
```

浏览器打开 `http://127.0.0.1:5173/`。Web 版可以完整检查界面和文字输入，但不会伪造录音或 Agent 结果。

### Android

还需要 JDK 21，以及包含 Android 36 Platform / Build Tools 的 Android SDK：

```bash
npm run android:debug
```

调试 APK 位于：

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

安装到已开启 USB 调试的设备：

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

公开版包名是 `org.openmemory.mylife.community`，不会覆盖家庭原型包。

### iPhone

需要 macOS、完整 Xcode 与一台模拟器或已配置签名的 iPhone：

```bash
npm run ios:sync
open ios/App/App.xcodeproj
```

选择 `App` scheme 后从 Xcode 运行。项目已包含麦克风、Apple Speech、Keychain 和本地 WAV 录音插件。仓库 CI 会在 macOS runner 上做无签名的 iOS Simulator 编译；发布到真机或 App Store 仍需要开发者自己的 Apple 签名。

## 验证

```bash
npm test
npm run build
npm run android:debug
npm audit
```

GitHub Actions 还会分别执行 Web 测试、Android APK 编译和 iOS Simulator 编译。

## 仍然没有做

- 完整备份的一键恢复
- 家庭成员之间的同步或远程备份
- 应用商店签名、TestFlight 与正式发布包
- Android / iPhone 的长时间真实讲述、断网与恢复矩阵测试
- 照片与历史影像生成

欢迎先把它用于一个真实的人，并把遇到的故事、方言、设备与恢复问题写进 issue。

## License

[MIT](LICENSE)
