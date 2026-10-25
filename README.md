# RoseTV

Windows 桌面影视播放器。支持分类筛选、搜索建议、影片收藏、观看记录、独立播放标签、全屏及可调整大小的小窗。

## 启动

双击 `App/RoseTV.exe`。启动器会启动 `tools/rosetv_bridge.py` 和 `App/rosetv-native.exe`；整个项目目录需要保留。

本机 Python 位置写在 `tools/python-path.txt`，不再写死在程序源代码中。启动器优先使用 `runtime/pythonw.exe`，其次读取 `ROSETV_PYTHON` 环境变量或本机配置，最后尝试 PATH 中的 `pythonw.exe`。

## 文件说明

| 目录 | 用途 |
| --- | --- |
| `App/` | 当前启动器、桌面窗口和第三方许可证 |
| `source/public/` | 当前桌面前端；主要维护 `js/rosetv.js`、`css/rosetv.css` |
| `source/src-tauri/` | 原生窗口源码；现用构建流程沿用已核验的原生内核 |
| `tools/` | 本地服务、登录会话、构建、离线及桌面检查脚本 |
| `docs/` | 当前使用、构建、缓存和来源维护说明 |
| `docs/archive/` | 历史说明与上游原始文档；不能当作当前构建指南 |
| `build/` | 生成的程序、构建清单和测试证据 |
| `Cache/` | 有上限的网络缓存与目录快照 |
| `backups/` | 校验过的原始程序和维护前代码备份 |
| `vendor/` | 可复现构建所需的压缩原生基底与说明 |
| `downloads/` | 用户保留的文件 |

旧网页部署入口已移到本机 `backups/legacy-web/`，桌面版以 `source/public/` 为准，避免改到重复的旧文件。公开仓库只包含维护中的源码、文档和必要构建资产。

## 开发和验证

```powershell
python -m pip install -r requirements.txt
python -m unittest discover -s tools -p "test_*.py" -q
node source/tests/performance.mjs
python tools/build_local.py
Copy-Item build/RoseTV.exe App/RoseTV.exe -Force
Copy-Item build/rosetv-native.exe App/rosetv-native.exe -Force
```

构建成功后生成 `build/RoseTV.exe`、`build/rosetv-native.exe` 及 `build/frontend-manifest.json`。关闭应用后再替换 `App/` 中对应文件。

首次构建会生成自己的本机密钥，缺少本地备份时从 `vendor/` 的已校验压缩基底构建。GitHub Actions 执行离线回归和 Windows 构建，不向影片网站做压力测试。

- [使用说明](docs/使用说明.md)
- [构建与分发](docs/构建与分发.md)
- [缓存与网络策略](docs/缓存与网络策略.md)
- [来源维护](docs/来源维护.md)
- [许可证与上游署名](NOTICE.md)

登录资料、配置密钥和浏览器档案是本机数据，不应随源码或程序发给其他人。当前本机版本尚未打成独立 Python 运行时发行包。
