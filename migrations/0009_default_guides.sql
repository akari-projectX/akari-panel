-- Default client guides (user request 2026-10-31): one published article per
-- platform (Windows, macOS, iOS, Android), each in its own category whose name
-- matches the portal's platform keywords (portal/src/shared/data/platforms.ts),
-- so 「按平台查看教程」 lands on them. Inserted only into a knowledge base that
-- is still empty (new sites, or sites that never wrote a guide); an operator
-- edits or deletes them like any other article (kb::apply_*). The text is
-- part of the portal font's character set (portal/scripts/font-slices.py reads
-- this file).
WITH empty AS (
    SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM kb_categories) AND NOT EXISTS (SELECT 1 FROM kb_articles)
),
guides (sort, cat_zh, cat_en, title_zh, title_en, body_zh, body_en) AS (
    VALUES
    (10, 'Windows 教程', 'Windows guides',
     'Windows：用 Clash Verge Rev 连接', 'Windows: connect with Clash Verge Rev',
     E'适用于 Windows 10 与 Windows 11。全程大约三分钟。\n\n'
     '## 1. 安装客户端\n\n'
     '1. 打开 [Clash Verge Rev 的发布页](https://github.com/clash-verge-rev/clash-verge-rev/releases/latest)。\n'
     '2. 下载文件名带 `x64-setup.exe` 的安装包（ARM 电脑选 `arm64-setup.exe`）。\n'
     '3. 双击安装，装好后打开 Clash Verge Rev。\n\n'
     '## 2. 导入订阅\n\n'
     '- **一键导入**：在门户的仪表盘点「导入到客户端」，选 Clash Verge，浏览器询问时允许打开应用。\n'
     '- **手动导入**：在仪表盘点「复制订阅链接」，打开客户端左侧的「订阅」，把链接粘贴到顶部输入框，点「导入」。\n\n'
     '## 3. 开始使用\n\n'
     '1. 回到「首页」，打开「系统代理」开关。\n'
     '2. 在「代理」页选一个节点，代理模式用「规则」。\n'
     '3. 打开浏览器访问任意网站，能打开即连接成功。\n\n'
     '## 常见问题\n\n'
     '- **导入失败**：确认复制的是完整链接，或在订阅上点右键选「更新」。\n'
     '- **能连上但很慢**：在「代理」页点测速图标，换一个延迟更低的节点。\n'
     '- **套餐续费或更换后**：在订阅上点「更新」，拿到最新的节点列表。',
     E'For Windows 10 and Windows 11. Takes about three minutes.\n\n'
     '## 1. Install the client\n\n'
     '1. Open the [Clash Verge Rev releases page](https://github.com/clash-verge-rev/clash-verge-rev/releases/latest).\n'
     '2. Download the installer whose name ends in `x64-setup.exe` (`arm64-setup.exe` on ARM PCs).\n'
     '3. Run it, then open Clash Verge Rev.\n\n'
     '## 2. Import the subscription\n\n'
     '- **One click**: on the portal dashboard choose "Import to client", pick Clash Verge and allow the browser to open the app.\n'
     '- **By hand**: choose "Copy subscription link" on the dashboard, open "Profiles" in the client, paste the link into the box at the top and choose "Import".\n\n'
     '## 3. Connect\n\n'
     '1. On "Home", turn on "System Proxy".\n'
     '2. On "Proxies", pick a node and keep the mode on "Rule".\n'
     '3. Open any website in your browser; if it loads, you are connected.\n\n'
     '## Troubleshooting\n\n'
     '- **Import fails**: make sure the whole link was copied, or right-click the profile and choose "Update".\n'
     '- **Connected but slow**: test latency on "Proxies" and switch to a faster node.\n'
     '- **After renewing or changing plans**: update the profile to get the latest node list.'),
    (20, 'macOS 教程', 'macOS guides',
     'macOS：用 Clash Verge Rev 连接', 'macOS: connect with Clash Verge Rev',
     E'适用于 macOS 11 及以上，Apple 芯片与 Intel 芯片都可以。\n\n'
     '## 1. 安装客户端\n\n'
     '1. 打开 [Clash Verge Rev 的发布页](https://github.com/clash-verge-rev/clash-verge-rev/releases/latest)。\n'
     '2. Apple 芯片（M1 及以后）下载文件名带 `aarch64.dmg` 的安装包，Intel 芯片下载带 `x64.dmg` 的。\n'
     '3. 打开 dmg，把应用拖进「应用程序」文件夹。\n'
     '4. 第一次打开如果提示「无法验证开发者」，到「系统设置 › 隐私与安全性」里点「仍要打开」。\n\n'
     '## 2. 导入订阅\n\n'
     '- **一键导入**：在门户的仪表盘点「导入到客户端」，选 Clash Verge，浏览器询问时允许打开应用。\n'
     '- **手动导入**：在仪表盘点「复制订阅链接」，打开客户端左侧的「订阅」，粘贴链接后点「导入」。\n\n'
     '## 3. 开始使用\n\n'
     '1. 回到「首页」，打开「系统代理」开关；系统要求输入密码时输入本机登录密码。\n'
     '2. 在「代理」页选一个节点，代理模式用「规则」。\n'
     '3. 打开 Safari 或其他浏览器访问任意网站，能打开即连接成功。\n\n'
     '## 常见问题\n\n'
     '- **打开系统代理后没有效果**：退出客户端再打开一次，或在「设置」里重新安装服务模式。\n'
     '- **套餐续费或更换后**：在订阅上点「更新」，拿到最新的节点列表。',
     E'For macOS 11 or later, on Apple silicon or Intel.\n\n'
     '## 1. Install the client\n\n'
     '1. Open the [Clash Verge Rev releases page](https://github.com/clash-verge-rev/clash-verge-rev/releases/latest).\n'
     '2. On Apple silicon (M1 or later) download the file ending in `aarch64.dmg`; on Intel, the one ending in `x64.dmg`.\n'
     '3. Open the dmg and drag the app into Applications.\n'
     '4. If macOS says the developer cannot be verified, go to System Settings › Privacy & Security and choose "Open Anyway".\n\n'
     '## 2. Import the subscription\n\n'
     '- **One click**: on the portal dashboard choose "Import to client", pick Clash Verge and allow the browser to open the app.\n'
     '- **By hand**: choose "Copy subscription link" on the dashboard, open "Profiles" in the client, paste the link and choose "Import".\n\n'
     '## 3. Connect\n\n'
     '1. On "Home", turn on "System Proxy"; enter your Mac password if asked.\n'
     '2. On "Proxies", pick a node and keep the mode on "Rule".\n'
     '3. Open any website in Safari or another browser; if it loads, you are connected.\n\n'
     '## Troubleshooting\n\n'
     '- **System Proxy has no effect**: quit and reopen the client, or reinstall the service mode in Settings.\n'
     '- **After renewing or changing plans**: update the profile to get the latest node list.'),
    (30, 'iOS 与 iPadOS 教程', 'iOS and iPadOS guides',
     'iPhone 与 iPad：用 Shadowrocket 连接', 'iPhone and iPad: connect with Shadowrocket',
     E'适用于 iOS 15 与 iPadOS 15 及以上。\n\n'
     '## 1. 安装客户端\n\n'
     '1. Shadowrocket 是 App Store 上的付费应用，中国大陆地区的商店里没有。\n'
     '2. 用一个其他国家或地区的 Apple ID 登录 App Store（只在「媒体与购买项目」里登录，不要改动 iCloud），搜索 Shadowrocket 并购买安装。\n\n'
     '## 2. 导入订阅\n\n'
     '- **一键导入**：在 iPhone 的 Safari 里打开门户，在仪表盘点「导入到客户端」，选 Shadowrocket，允许打开应用。\n'
     '- **手动导入**：在仪表盘点「复制订阅链接」，打开 Shadowrocket，点右上角的「+」，类型选「Subscribe」，把链接粘贴到「URL」，点「完成」。\n\n'
     '## 3. 开始使用\n\n'
     '1. 第一次连接时，系统会询问是否允许添加 VPN 配置，点「允许」并输入锁屏密码。\n'
     '2. 在首页选一个节点，打开顶部的连接开关。\n'
     '3. 「全局路由」选「配置」，国内网站直连、其他网站走代理。\n\n'
     '## 常见问题\n\n'
     '- **节点列表是空的**：在首页的订阅上向左滑，点「更新」。\n'
     '- **连上后部分应用打不开**：关掉连接再打开一次，或换一个节点。\n'
     '- **套餐续费或更换后**：更新订阅，拿到最新的节点列表。',
     E'For iOS 15 and iPadOS 15 or later.\n\n'
     '## 1. Install the client\n\n'
     '1. Shadowrocket is a paid app on the App Store and is not sold in the mainland China store.\n'
     '2. Sign in to the App Store with an Apple ID from another country or region (under Media & Purchases only; leave iCloud alone), search for Shadowrocket and buy it.\n\n'
     '## 2. Import the subscription\n\n'
     '- **One click**: open the portal in Safari on the iPhone, choose "Import to client" on the dashboard, pick Shadowrocket and allow it to open.\n'
     '- **By hand**: choose "Copy subscription link" on the dashboard, open Shadowrocket, tap "+" at the top right, set the type to "Subscribe", paste the link into "URL" and tap "Done".\n\n'
     '## 3. Connect\n\n'
     '1. The first time, iOS asks to add a VPN configuration: tap "Allow" and enter your passcode.\n'
     '2. Pick a node on the home screen and turn on the switch at the top.\n'
     '3. Set "Global Routing" to "Config" so local sites stay direct and the rest go through the proxy.\n\n'
     '## Troubleshooting\n\n'
     '- **No nodes listed**: swipe left on the subscription on the home screen and tap "Update".\n'
     '- **Some apps fail after connecting**: turn the connection off and on, or try another node.\n'
     '- **After renewing or changing plans**: update the subscription to get the latest node list.'),
    (40, 'Android 教程', 'Android guides',
     'Android：用 Clash Meta for Android 连接', 'Android: connect with Clash Meta for Android',
     E'适用于 Android 7 及以上；鸿蒙手机（兼容安卓应用的版本）同样适用。\n\n'
     '## 1. 安装客户端\n\n'
     '1. 打开 [Clash Meta for Android 的发布页](https://github.com/MetaCubeX/ClashMetaForAndroid/releases/latest)。\n'
     '2. 大多数手机下载文件名带 `arm64-v8a` 的 apk；不确定就下载带 `universal` 的。\n'
     '3. 打开下载好的 apk 安装；系统提示「未知来源」时，允许浏览器安装应用。\n\n'
     '## 2. 导入订阅\n\n'
     '- **一键导入**：在手机浏览器里打开门户，在仪表盘点「导入到客户端」，选 Clash Meta，允许打开应用后点保存。\n'
     '- **手动导入**：在仪表盘点「复制订阅链接」，打开客户端的「配置」，点右上角「+」，选「URL」，粘贴链接，点右上角保存。\n\n'
     '## 3. 开始使用\n\n'
     '1. 在「配置」里选中刚导入的配置。\n'
     '2. 回到首页点「已停止」启动，系统询问时允许创建 VPN 连接。\n'
     '3. 在「代理」页选一个节点。\n\n'
     '## 常见问题\n\n'
     '- **一段时间后自动断开**：在系统设置里把客户端的电池策略设为「不限制」，并允许后台运行。\n'
     '- **套餐续费或更换后**：在「配置」里点更新图标，拿到最新的节点列表。',
     E'For Android 7 or later; also works on HarmonyOS phones that run Android apps.\n\n'
     '## 1. Install the client\n\n'
     '1. Open the [Clash Meta for Android releases page](https://github.com/MetaCubeX/ClashMetaForAndroid/releases/latest).\n'
     '2. Most phones need the apk whose name contains `arm64-v8a`; if unsure, take the `universal` one.\n'
     '3. Open the downloaded apk to install it, allowing your browser to install apps if asked.\n\n'
     '## 2. Import the subscription\n\n'
     '- **One click**: open the portal in your phone''s browser, choose "Import to client" on the dashboard, pick Clash Meta, allow it to open and save.\n'
     '- **By hand**: choose "Copy subscription link" on the dashboard, open "Profiles" in the client, tap "+" at the top right, choose "URL", paste the link and save.\n\n'
     '## 3. Connect\n\n'
     '1. In "Profiles", select the profile you just imported.\n'
     '2. Back on the home screen, tap "Stopped" to start, and allow the VPN connection when asked.\n'
     '3. Pick a node on "Proxy".\n\n'
     '## Troubleshooting\n\n'
     '- **It disconnects after a while**: set the app''s battery usage to "Unrestricted" and allow it to run in the background.\n'
     '- **After renewing or changing plans**: tap the update icon in "Profiles" to get the latest node list.')
),
cats AS (
    INSERT INTO kb_categories (id, name_zh, name_en, sort)
    SELECT gen_random_uuid(), g.cat_zh, g.cat_en, g.sort FROM guides g, empty
    RETURNING id, name_zh
)
INSERT INTO kb_articles (id, category_id, title_zh, title_en, body_zh, body_en, sort, published)
SELECT gen_random_uuid(), c.id, g.title_zh, g.title_en, g.body_zh, g.body_en, 0, true
FROM guides g JOIN cats c ON c.name_zh = g.cat_zh;
