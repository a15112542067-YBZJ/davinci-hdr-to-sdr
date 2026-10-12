# DaVinci Resolve HDR 转 SDR

Windows 下的 DaVinci Resolve Studio 工作流插件。识别媒体池选中素材，批量生成 Rec.709 SDR 副本，并导入原素材所在媒体池文件夹的“转换SDR”子文件夹。输出文件添加 `_转换SDR` 后缀，保留原文件。

版本：1.0.3。安装操作见 [安装说明](安装说明.md)。

## 功能

- 界面显示格式、转换资格、逐条进度、错误原因和批次完成通知。
- NVIDIA GPU 模式使用 CUDA 解码、libplacebo 色调映射与 NVENC HEVC Main10 编码；CPU 模式提供 HEVC 10-bit 或 DNxHR HQX。
- 识别符合条件的 BT.2020 HLG/PQ、部分 Dolby Vision 素材。自动依据元数据判断，不依据设备名称猜测。
- 跳过不可解码的附加音轨，例如 APAC，同时保留可解码音轨；如果音轨全部不可解码，则拒绝转换，避免无声输出。
- 校验输出的 Rec.709 标签、残留 HDR 元数据、时长和音轨数量。
- “导入已有 SDR”可恢复已生成但未导入的文件；批量转换也会复用校验通过的已有副本。

## 条件与限制

Windows；DaVinci Resolve **Studio**，需提供 Workflow Integration SDK 接口文件。本机验证环境为 Studio 21.1，其他版本兼容性需自行验证。

单独准备支持 `libplacebo` / `apply_dolbyvision` 的 FFmpeg 和 ffprobe，以及可用的 Vulkan 显卡驱动。CPU 编码模式仍使用 libplacebo/Vulkan 进行色调映射。GPU 编码需要支持 HEVC Main10 的 NVIDIA 显卡和驱动；不支持时请手动选择 CPU 模式，当前不提供 AMD/Intel 硬件编码。

Dolby Vision 主要支持符合标签条件的 Profile 8；Profile 5 必须能解码出所需动态元数据。其他配置可能跳过。HDR Vivid 只转换基础层，不实现其专有动态映射；HDR10+ 不实现其专用逐场景映射。未知格式、Log、SDR、隔行扫描或缺少必要标签的素材会跳过。检测只抽样前 120 个包，不能保证识别全部动态元数据。

转换的是完整源文件，不包含时间线剪辑、调色或特效；这不是可套在调色节点上的 DCTL/OFX 特效。输出效果不承诺与剪映一致。

## 开发与验证

插件由 Electron 宿主加载，不需要使用者安装 Node.js。开发测试需要 Node.js：

```powershell
node --test tests/core.test.js tests/integration.test.js
```

设置 `HDR_FFMPEG` 和 `HDR_FFPROBE` 为可执行文件完整路径可运行实际转码测试；未设置时跳过实际转码测试。媒体池调用使用模拟接口测试，最终宿主行为仍需在 Resolve 中验证。

## 许可

项目源码使用 MIT 许可证。FFmpeg、libplacebo、NVIDIA 驱动和 Blackmagic SDK 有各自许可。本包不分发 FFmpeg 或 Blackmagic 原生接口二进制，安装时读取使用者本机接口文件。项目与 Blackmagic Design、Apple、剪映无隶属关系。
