# WuCloud Sync

**SillyTavern extension** — cloud backup of characters, chats, personas, lorebooks and generation presets to [WuProj](https://wuproj.com) («Файлы ИИ»).

> This repository contains **only** the SillyTavern extension (installable by Git URL).  
> Backend and dashboard live in the WuApi product — not in this repo.

## Install in SillyTavern

1. Open **Extensions**
2. **Install extension**
3. Paste:

```text
https://github.com/shastitko1970-netizen/wucloud-sync
```

4. Confirm install (all users / current user)
5. Enable **WuCloud Sync** if needed
6. Open the extension drawer → paste your **`wu-…` API key** from [WuProj dashboard](https://wuproj.com/dashboard)

Requires **git** on the machine running SillyTavern.

### Manual install

```bash
git clone https://github.com/shastitko1970-netizen/wucloud-sync \
  "public/scripts/extensions/third-party/wucloud-sync"
```

(or into `data/<user>/extensions/wucloud-sync` for single-user installs)

## Features

| Feature | Status |
|---------|--------|
| Push character cards (PNG) | ✅ |
| Push current chat / all chats of character (upsert) | ✅ |
| Skip unchanged (content hash + client_key) | ✅ |
| Personas / lorebooks / presets (opt-in upsert) | ✅ |
| Autosave chat (debounce / interval) | ✅ |
| Mapping in localforage (not settings bloat) | ✅ |
| Pull: characters into ST | ✅ |
| Pull: chat blobs (jsonl) into ST / download | ✅ v1.3 |
| Pull: lorebooks + presets (import or download) | ✅ v1.3 |
| Lossless chat blobs + gzip at rest | ✅ `/api/v2/st-sync/blobs` |
| Cold archive idle blobs | ✅ `/api/v2/st-sync/archive` |

## Settings

- **API key** — `wu-…` from the dashboard  
- **Base URL** — default `https://api.wuproj.com`  
- **What to sync** — characters, chats, personas, lorebooks, presets  
- **Autosave** — off / after message / interval  

Manage cloud files in the browser: **Dashboard → Файлы ИИ**.

## Privacy

The API key is stored in SillyTavern extension settings (local plaintext, like most ST extensions). Use a dedicated key you can revoke.

## License

MIT — see [LICENSE](./LICENSE).

## Links

- Dashboard: https://wuproj.com/dashboard  
- Issues: https://github.com/shastitko1970-netizen/wucloud-sync/issues  
