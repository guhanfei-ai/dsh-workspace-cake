/**
 * dsh-workspace-cake
 *
 * 左下侧栏「工作区」这一块的三个能力，全在一个包里：
 *
 * 1. 工作区右键菜单（右键和行尾「⋯」是同一个共享菜单）
 *    置顶 / 打开文件树 / 打开终端 / 复制绝对路径 / 在 Cursor 中打开 / 在 VS Code 中打开
 * 2. 置顶：置顶的工作区永远排在前面，置顶之间也按最近更新时间排
 * 3. 工作区分组的最近更新排序：有新对话的工作区自动往上走
 *
 * 排序用侧栏注册自己的组件接缝：把 sidebar.workspaces 的组件包一层，
 * 只改写它读到的 items 顺序，不碰宿主的持久化顺序、不移动会话数据。
 *
 * 调参只改下面「可调参数」这一块，改完保存、刷新页面即可。
 */
window.__ModuleLoader__.load({
  id: 'dsh-workspace-cake',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'dsh-workspace-cake'

    /**
     * 菜单图标：跟宿主的 Solar 图标集同一套比例（24 viewBox、1.5 描边、圆头），
     * 用 currentColor 跟随菜单前景色，所以明暗主题都不用另配颜色。
     */
    const glyph = (paths) => () => h('svg', {
      viewBox: '0 0 24 24', width: 16, height: 16,
      fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
      strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
    }, paths.map((d, index) => h('path', { key: index, d })))

    const TreeIcon = glyph([
      'M3 7.5a2 2 0 0 1 2-2h3.4a2 2 0 0 1 1.6 .8l1.2 1.7H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
      'M8.5 11.5v4.5',
      'M11.5 12.8h-3M11.5 15.2h-3',
    ])

    const TerminalIcon = glyph([
      'M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
      'M7.5 10.5 10.5 13l-3 2.5',
      'M12.5 15.5h4',
    ])

    const CopyIcon = glyph([
      'M9 9V6.5A2.5 2.5 0 0 1 11.5 4h6A2.5 2.5 0 0 1 20 6.5v6A2.5 2.5 0 0 1 17.5 15H15',
      'M4 11.5A2.5 2.5 0 0 1 6.5 9h6a2.5 2.5 0 0 1 2.5 2.5v6a2.5 2.5 0 0 1-2.5 2.5h-6A2.5 2.5 0 0 1 4 17.5z',
    ])

    /** 应用图标用宿主 open-in-app 的图标路由（系统里那个 App 的图标），取不到退回通用角标。 */
    function ApplicationIcon({ icon }) {
      const [failed, setFailed] = React.useState()
      if (!icon?.src || icon.src === failed) {
        return h('svg', {
          viewBox: '0 0 24 24', width: 14, height: 14,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        }, h('path', { d: 'M9 5H6.5A2.5 2.5 0 0 0 4 7.5v10A2.5 2.5 0 0 0 6.5 20h10a2.5 2.5 0 0 0 2.5-2.5V15' }), h('path', { d: 'M14 4h6v6M20 4l-9 9' }))
      }
      return h('img', {
        src: icon.src, width: 14, height: 14, alt: '', draggable: false,
        onError: () => setFailed(icon.src),
      })
    }

    // ── 可调参数 ─────────────────────────────────────────────────────────
    /** 终端开在哪里：'bottom' = dsh-better-sidebar 底部工作台；'right' = 宿主侧边栏终端页。 */
    const TERMINAL_TARGET = 'bottom'

    /**
     * 工作区分组要不要按「最近更新」重排。关掉它就只保留置顶分组，
     * 其余分组回到宿主自己的顺序（拖动排序的结果）。
     */
    const RECENT_ORDER = true

    /** 菜单顺序：内置「重命名」100、「在 Finder 中显示」200、「删除」300。 */
    /**
     * 菜单顺序。内置「重命名」100、「在 Finder 中显示」200、「删除」300。
     * 我们的项从 103 起步、每位隔 2（103/105/107/109/111）：
     * 留出空位，将来插一项不用重排后面的号。
     */
    const MENU_ORDER = { pin: 90, tree: 103, terminal: 105, copyPath: 107, cursor: 109, vscode: 111 }

    /** 切到目标工作区后，等它真正出现在屏上的上限（毫秒）。 */
    const NAVIGATION_TIMEOUT_MS = 8000

    /** 侧边栏开页的重试次数：会话刚切上屏、侧栏刚展开时，它的 surface 可能还没建好。 */
    const OPEN_ATTEMPTS = 12
    const OPEN_RETRY_DELAY_MS = 120

    /** 置顶集合存在浏览器本地，跟宿主顺序无关。 */
    const PIN_STORAGE_KEY = 'dsh-workspace-cake.pinned.v1'

    /**
     * 置顶块与普通分组之间那条分隔线的颜色。
     * 默认取宿主的浅灰边框色（明暗主题自动跟随）；想更淡就改成
     * `color-mix(in srgb, var(--dsw-alias-border-l1) 60%, transparent)`，
     * 不想要线就设成 `transparent`。
     */
    const DIVIDER_COLOR = 'var(--dsw-alias-border-l1)'

    /**
     * 名字被「染上」的蓝紫：静态着色，不做动画。
     *
     * 正在输出 → 染上并呼吸；刚跑完还没看 → 保持染着但不呼吸；看过了 → 褪掉。
     * 用 light-dark() 给亮/暗各配一版（格式：light-dark(<亮色>, <暗色>)）。
     * 想要截图里那个天蓝，把两个值换成 light-dark(#2f6f9e, #74a6d0) 即可。
     */
    const DYE_COLOR = 'light-dark(#3f51a8, #93a4f5)'

    /** 「输出中」时名字呼吸的周期（秒）与最淡那档——只有正在输出才动，跑完就静止染色。 */
    const BREATH_SECONDS = 2.8
    const BREATH_DIM_OPACITY = 0.6

    /**
     * 有未读完成的工作区：行左侧一条静态短竖条。
     * 动效只留给「还在发生」，未读用不动的标记，两种状态走不同通道，不会互相盖掉。
     */
    const UNREAD_BAR_COLOR = 'var(--dsw-alias-state-warn-primary)'
    const UNREAD_BAR_WIDTH = 3

    /** React 重绘后补标记的合并窗口。 */
    const MARK_DELAY_MS = 80
    // ────────────────────────────────────────────────────────────────────

    /** 宿主 open-in-app 的三条路由（浏览器相对地址，由同一个 WebServer 提供）。 */
    const OPEN_IN_APP = { apps: 'open-in-app/apps', icon: 'open-in-app/icon', open: 'open-in-app/open' }

    /** 菜单里露出的编辑器：id 来自宿主的固定应用目录。 */
    const EDITORS = [
      { id: 'cursor', key: 'openCursor', order: MENU_ORDER.cursor, setting: 'menuCursor' },
      { id: 'vscode', key: 'openVSCode', order: MENU_ORDER.vscode, setting: 'menuVscode' },
    ]

    const sleep = delay => new Promise(resolve => setTimeout(resolve, delay))

    /** 共用的空集合：避免每次渲染都造新数组，memo 才能稳定。 */
    const EMPTY_IDS = Object.freeze([])

    /** 当前有对话在跑 / 有未读完成的工作区 id；由排序包装层写入，标记 effect 读取。 */
    let runningWorkspaces = new Set()
    let unreadWorkspaces = new Set()
    let failedWorkspaces = new Set()
    /** 标记 effect 挂上来之后，React 侧状态变化时直接请求重标。 */
    let requestMark = null

    // ── 设置（浏览器本地；设置页与运行时共用同一份） ─────────────────────
    const SETTINGS_KEY = 'dsh-workspace-cake.settings.v1'

    /**
     * 每个开关默认开启；旧存档缺的键按默认补齐，坏值一律当默认。
     * 键名就是设置页里的那一行，运行时各处直接读同一份快照。
     */
    const DEFAULT_SETTINGS = Object.freeze({
      breath: true,
      unreadDye: true,
      unreadBar: true,
      menuPin: true,
      menuTree: true,
      menuTerminal: true,
      menuCopyPath: true,
      menuCursor: true,
      menuVscode: true,
      recent: true,
      collapse: true,
    })

    function readSettings() {
      const next = { ...DEFAULT_SETTINGS }
      try {
        const raw = localStorage.getItem(SETTINGS_KEY)
        const parsed = raw === null ? null : JSON.parse(raw)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return next
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (typeof parsed[key] === 'boolean') next[key] = parsed[key]
        }
        return next
      } catch (error) {
        console.warn('[dsh-workspace-cake] 设置读取失败，按默认处理：', error)
        return next
      }
    }

    let currentSettings = readSettings()
    const settingsListeners = new Set()
    const settingsSnapshot = () => currentSettings
    const subscribeSettings = (listener) => {
      settingsListeners.add(listener)
      return () => settingsListeners.delete(listener)
    }

    /**
     * 把三个视觉开关写到 <html> 的数据属性上：CSS 按属性生效，
     * 切换开关不用重建样式，也不用重新标记行。
     */
    function paintSettingsToDom() {
      const root = document.documentElement
      root.dataset.cakeBreath = currentSettings.breath ? 'on' : 'off'
      root.dataset.cakeUnreadDye = currentSettings.unreadDye ? 'on' : 'off'
      root.dataset.cakeUnreadBar = currentSettings.unreadBar ? 'on' : 'off'
    }

    function publishSettings() {
      paintSettingsToDom()
      for (const listener of [...settingsListeners]) listener()
      if (requestMark !== null) requestMark()
    }

    function writeSettings(patch) {
      currentSettings = { ...currentSettings, ...patch }
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(currentSettings))
      } catch (error) {
        console.warn('[dsh-workspace-cake] 设置写入失败：', error)
      }
      publishSettings()
    }

    // ── 置顶集合（浏览器本地，跨页面用 storage 事件同步） ─────────────────
    function readPinned() {
      try {
        const raw = localStorage.getItem(PIN_STORAGE_KEY)
        const list = raw === null ? [] : JSON.parse(raw)
        return Array.isArray(list) ? list.filter(item => typeof item === 'string') : []
      } catch (error) {
        console.warn('[dsh-workspace-cake] 置顶集合读取失败，按空处理：', error)
        return []
      }
    }

    let pinnedIds = readPinned()
    const pinnedListeners = new Set()

    const pinnedSnapshot = () => pinnedIds
    const subscribePinned = (listener) => {
      pinnedListeners.add(listener)
      return () => pinnedListeners.delete(listener)
    }

    function writePinned(next) {
      pinnedIds = next
      try {
        localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify(next))
      } catch (error) {
        console.warn('[dsh-workspace-cake] 置顶集合写入失败：', error)
      }
      for (const listener of [...pinnedListeners]) listener()
    }

    function togglePinned(workspaceId) {
      const next = new Set(pinnedIds)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      writePinned([...next])
    }

    // ── 排序：置顶优先，其次最近更新 ─────────────────────────────────────
    const selectGroupBy = state => state.groupBy
    const selectOrderBy = state => state.orderBy
    const selectItems = state => state.items
    const selectSessions = state => state
    const selectStatuses = state => state

    /**
     * 一个工作区最近一次真实对话的时间。
     * 跳过新建会话占位（blank）和子代理派生的会话（origin === 'subagent'），
     * 归档会话仍然算数——它们也是一次真实对话。没有对话返回 -1，排在后面。
     */
    function newestConversation(sessionIds, byId) {
      let newest = -1
      if (!Array.isArray(sessionIds) || byId === undefined || byId === null) return newest
      for (const sessionId of sessionIds) {
        const row = byId[sessionId]
        if (row === undefined || row.blank === true || row.origin === 'subagent') continue
        const at = row.updatedAt
        if (typeof at === 'number' && Number.isFinite(at) && at > newest) newest = at
      }
      return newest
    }

    /**
     * 分组顺序：置顶的整块在前，块内按最近更新；其余按最近更新。
     * 时间相同就保持宿主给的相对顺序，结果稳定不跳。
     * `useRecency` 为 false 时只做置顶分区，其余顺序原样保留（手动排序模式就这样）。
     */
    function arrangeGroups(items, byId, pinned, useRecency) {
      if (!Array.isArray(items) || items.length === 0) return items
      const pinnedSet = new Set(pinned)
      if (pinnedSet.size === 0 && !useRecency) return items

      const rank = new Map()
      items.forEach((item, index) => {
        rank.set(item, {
          index,
          pinned: pinnedSet.has(item.workspaceId) ? 1 : 0,
          newest: useRecency ? newestConversation(item.sessionIds, byId) : -1,
        })
      })

      return [...items].sort((a, b) => {
        const left = rank.get(a)
        const right = rank.get(b)
        if (left.pinned !== right.pinned) return right.pinned - left.pinned
        if (left.newest !== right.newest) return right.newest - left.newest
        return left.index - right.index
      })
    }

    // ── 会话归属 / 切屏（打开文件树、打开终端要用） ───────────────────────
    function workspaceOfSession(snapshot, sessionId) {
      return snapshot.items.find(item => item.sessionIds.includes(sessionId))
    }

    function waitMounted(ctx, sessionId) {
      const mounted = ctx.sidebarRight.mounted
      if (mounted.getSnapshot() === sessionId) return Promise.resolve()
      return new Promise((resolve, reject) => {
        let dispose
        const timer = setTimeout(() => {
          if (dispose) dispose()
          reject(new Error(`切换到该工作区超时：${sessionId}`))
        }, NAVIGATION_TIMEOUT_MS)
        dispose = mounted.subscribe(() => {
          if (mounted.getSnapshot() !== sessionId) return
          clearTimeout(timer)
          dispose()
          resolve()
        })
      })
    }

    async function presentWorkspace(ctx, workspaceId) {
      const snapshot = ctx.workspaces.list.getSnapshot()
      const workspace = snapshot.items.find(item => item.workspaceId === workspaceId)
      if (workspace === undefined) throw new Error(`找不到工作区：${workspaceId}`)

      const current = ctx.sidebarRight.mounted.getSnapshot()
      if (current !== undefined && workspaceOfSession(snapshot, current)?.workspaceId === workspaceId) return current

      const reusable = workspace.sessionIds.find(id => !snapshot.archivedSessionIds.includes(id))
      ctx.contextMenus.notify(ctx.locale.bind(NS)('switching'), true)
      const sessionId = reusable ?? await ctx.uiWorkspace.connectWorkspace(workspaceId)
      ctx.uiWorkspace.openSession(sessionId)
      await waitMounted(ctx, sessionId)
      return sessionId
    }

    async function openRight(ctx, kind) {
      for (let attempt = 1; ; attempt++) {
        if (!ctx.sidebarRight.isExpanded()) ctx.sidebarRight.toggleExpanded()
        try {
          ctx.sidebarRight.openTab(kind)
          return
        } catch (error) {
          if (attempt >= OPEN_ATTEMPTS) throw error
          await sleep(OPEN_RETRY_DELAY_MS)
        }
      }
    }

    async function openTree(ctx, workspaceId) {
      await presentWorkspace(ctx, workspaceId)
      await openRight(ctx, 'files')
    }

    function terminalRoute(ctx) {
      const better = ctx.get('betterSidebar')
      const bottomReady = TERMINAL_TARGET !== 'right'
        && typeof better?.openTab === 'function'
        && better.getTab?.('terminal-bottom') !== undefined
        && better.isTabEnabled?.('terminal-bottom') !== false
      return bottomReady ? { route: 'bottom', better } : { route: 'right', better }
    }

    async function openTerminal(ctx, workspaceId) {
      const sessionId = await presentWorkspace(ctx, workspaceId)
      const { route, better } = terminalRoute(ctx)
      if (route === 'right') {
        await openRight(ctx, 'terminal')
        return
      }
      better.openTab({ type: 'terminal-bottom', target: 'bottom' }, { sessionId })
    }

    // ── 宿主应用目录（VS Code / Cursor） ─────────────────────────────────
    let installedApps = null
    let appsLoading = null
    let appsNextTry = 0

    function ensureApps() {
      if (installedApps !== null) return Promise.resolve(installedApps)
      if (appsLoading !== null) return appsLoading
      if (Date.now() < appsNextTry) return Promise.resolve(null)
      appsLoading = fetch(OPEN_IN_APP.apps, { headers: { accept: 'application/json' } })
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
          const payload = await response.json()
          const ids = Array.isArray(payload) ? payload : payload?.apps
          installedApps = Array.isArray(ids) ? ids : []
          return installedApps
        })
        .catch((error) => {
          console.warn('[dsh-workspace-cake] 读不到宿主应用列表，VS Code / Cursor 菜单项先隐藏：', error)
          installedApps = null
          appsNextTry = Date.now() + 30_000
          return null
        })
        .finally(() => { appsLoading = null })
      return appsLoading
    }

    function hasApp(id) {
      if (installedApps === null) {
        void ensureApps()
        return false
      }
      return installedApps.includes(id)
    }

    async function launchApp(appId, path) {
      const response = await fetch(OPEN_IN_APP.open, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app: appId, path }),
      })
      if (!response.ok) throw new Error(`open-in-app 拒绝了请求：HTTP ${String(response.status)}`)
    }

    return {
      inject: ['contextMenus', 'uiWorkspace', 'sidebarRight', 'workspaces', 'locale', 'slots'],

      apply(ctx) {
        void ensureApps()

        ctx.effect(() => ctx.locale.register(NS, {
          zh: {
            pin: '置顶',
            unpin: '取消置顶',
            openTree: '打开文件树',
            openTerminal: '打开终端',
            copyPath: '复制绝对路径',
            openVSCode: '在 VS Code 中打开',
            openCursor: '在 Cursor 中打开',
            switching: '正在切换到该工作区…',
            copied: '已复制路径',
            dragBlocked: '最近更新排序下拖动不会生效，切到「手动排序」再拖',
            settingsNav: '工作区Cake',
            foldAll: '折叠全部工作区',
            'settings.groupVisual': '工作区可视化效果',
            'settings.groupMenu': '工作区右键菜单',
            'settings.groupOrder': '工作区位置排序',
            'settings.groupCollapse': '工作区折叠按钮',
            'breath.label': '呼吸动效',
            'breath.desc': '正在输出的工作区，名字以蓝紫色缓慢呼吸；关掉后只保留静态着色',
            'unreadDye.label': '未读提醒 - 静态染色',
            'unreadDye.desc': '跑完但还没看的工作区，名字静止染着蓝紫，读过之后褪掉',
            'unreadBar.label': '未读提醒 - 左侧竖线',
            'unreadBar.desc': '跑完但还没看的工作区，行左侧一条短竖线；出错时换成错误色',
            'menuPin.label': '置顶功能',
            'menuPin.desc': '右键里的「置顶 / 取消置顶 / 取消全部置顶」，以及让置顶的分组排在最前面',
            'menuTree.label': '打开文件树',
            'menuTree.desc': '右键菜单里的「打开文件树」',
            'menuTerminal.label': '打开终端',
            'menuTerminal.desc': '右键菜单里的「打开终端」',
            'menuCopyPath.label': '复制绝对路径',
            'menuCopyPath.desc': '右键菜单里的「复制绝对路径」',
            'menuCursor.label': '在 Cursor 中打开',
            'menuCursor.desc': '右键菜单里的「在 Cursor 中打开」（只在探测到已安装时出现）',
            'menuVscode.label': '在 VS Code 中打开',
            'menuVscode.desc': '右键菜单里的「在 VS Code 中打开」（只在探测到已安装时出现）',
            'recent.label': '最新发言的工作区自动上浮',
            'recent.desc': '有「按工作区」分组时，最近有对话的工作区自动往上走；关掉就回到宿主自己的顺序',
            'collapse.label': '折叠工作区专用按钮',
            'collapse.desc': '工作区标题栏右侧一个向心箭头按钮，一键收起所有展开的分组',            failed: '操作失败，详情已写入控制台',
          },
          en: {
            pin: 'Pin to top',
            unpin: 'Unpin',
            openTree: 'Open file tree',
            openTerminal: 'Open terminal',
            copyPath: 'Copy absolute path',
            openVSCode: 'Open in VS Code',
            openCursor: 'Open in Cursor',
            switching: 'Switching to that workspace…',
            copied: 'Path copied',
            dragBlocked: 'Dragging has no effect while sorting by last update; switch to Manual order to arrange groups',
            settingsNav: 'Workspace cake',
            foldAll: 'Collapse all workspaces',
            'settings.groupVisual': 'Workspace appearance',
            'settings.groupMenu': 'Workspace context menu',
            'settings.groupOrder': 'Workspace ordering',
            'settings.groupCollapse': 'Collapse button',
            'breath.label': 'Breathing animation',
            'breath.desc': 'A workspace that is outputting breathes its name in blue violet; off keeps the static tint only',
            'unreadDye.label': 'Unread reminder - static tint',
            'unreadDye.desc': 'A workspace that finished but has not been read keeps a tinted name until you open it',
            'unreadBar.label': 'Unread reminder - left bar',
            'unreadBar.desc': 'A short bar on the left edge of a finished-but-unread workspace; it turns to the error colour on failure',
            'menuPin.label': 'Pin workspaces',
            'menuPin.desc': 'The Pin / Unpin / Unpin all entries, plus keeping pinned groups at the top',
            'menuTree.label': 'Open file tree',
            'menuTree.desc': 'The Open file tree entry',
            'menuTerminal.label': 'Open terminal',
            'menuTerminal.desc': 'The Open terminal entry',
            'menuCopyPath.label': 'Copy absolute path',
            'menuCopyPath.desc': 'The Copy absolute path entry',
            'menuCursor.label': 'Open in Cursor',
            'menuCursor.desc': 'Shown only when Cursor is detected as installed',
            'menuVscode.label': 'Open in VS Code',
            'menuVscode.desc': 'Shown only when VS Code is detected as installed',
            'recent.label': 'Float workspaces with recent activity',
            'recent.desc': 'In Group by Workspace, a workspace with a newer conversation rises; off keeps the host order',
            'collapse.label': 'Collapse-all button',
            'collapse.desc': 'One converging-arrow button in the workspace header that folds every expanded group',            failed: 'Action failed; details are in the console',
          },
        }), 'dsh-workspace-cake: copy')

        const t = ctx.locale.bind(NS)

        /** 菜单执行器会丢掉错误对象，所以自己把错误打进控制台，不然「详情已写入控制台」是空话。 */
        const contribute = (providerId, actionId, order, iconKey, label, run, available = () => true) =>
          ctx.contextMenus.register({
            id: providerId,
            target: 'workspace',
            order,
            resolve: (target) => {
              if (!available()) return []
              return [{
                id: actionId,
                label: label(target),
                icon: { key: iconKey(target) },
                failureLabel: t('failed'),
                run: () => Promise.resolve()
                  .then(() => run(target))
                  .catch((error) => {
                    console.error('[dsh-workspace-cake]', error)
                    throw error
                  }),
              }]
            },
          })

        ctx.effect(() => contribute(
          'dsh-workspace-cake.pin',
          'pin',
          MENU_ORDER.pin,
          target => (pinnedIds.includes(target.workspaceId) ? 'workspace.unpin' : 'workspace.pin'),
          target => t(pinnedIds.includes(target.workspaceId) ? 'unpin' : 'pin'),
          // 置顶是本地偏好，不碰工作区、不碰会话，所以连失败分支都没有。
          (target) => { togglePinned(target.workspaceId) },
          () => currentSettings.menuPin,
        ), 'dsh-workspace-cake: pin entry')

        ctx.effect(() => contribute(
          'dsh-workspace-cake.open-tree',
          'open-tree',
          MENU_ORDER.tree,
          () => 'dsh-workspace-cake.tree',
          () => t('openTree'),
          target => openTree(ctx, target.workspaceId),
          () => currentSettings.menuTree,
        ), 'dsh-workspace-cake: file tree entry')

        ctx.effect(() => contribute(
          'dsh-workspace-cake.open-terminal',
          'open-terminal',
          MENU_ORDER.terminal,
          () => 'dsh-workspace-cake.terminal',
          () => t('openTerminal'),
          target => openTerminal(ctx, target.workspaceId),
          () => currentSettings.menuTerminal,
        ), 'dsh-workspace-cake: terminal entry')

        ctx.effect(() => contribute(
          'dsh-workspace-cake.copy-path',
          'copy-path',
          MENU_ORDER.copyPath,
          () => 'dsh-workspace-cake.copy',
          () => t('copyPath'),
          async (target) => {
            await navigator.clipboard.writeText(target.path)
            ctx.contextMenus.notify(t('copied'), true)
          },
          () => currentSettings.menuCopyPath,
        ), 'dsh-workspace-cake: copy path entry')

        for (const editor of EDITORS) {
          ctx.effect(() => contribute(
            `dsh-workspace-cake.open-${editor.id}`,
            `open-${editor.id}`,
            editor.order,
            () => 'dsh-workspace-cake.application',
            () => t(editor.key),
            target => launchApp(editor.id, target.path),
            () => currentSettings[editor.setting] && hasApp(editor.id),
          ), `dsh-workspace-cake: ${editor.id} entry`)
        }

        // ── 排序投影：包住侧栏的 WorkspaceBrowser，只改写它读到的 items 顺序 ──
        ctx.effect(() => {
          let installed = null

          const restore = () => {
            if (installed === null) return
            if (installed.entry.component === installed.wrapper) installed.entry.component = installed.original
            installed = null
          }

          const install = () => {
            let entry
            try {
              entry = ctx.slots.entries('sidebar.workspaces')[0]
            } catch (error) {
              console.warn('[dsh-workspace-cake] 读不到侧栏注册，排序投影跳过：', error)
              return
            }
            if (entry === undefined || typeof entry.component !== 'function') return
            if (installed !== null && installed.entry === entry && installed.entry.component === installed.wrapper) return

            restore()
            const Original = entry.component

            const tr = ctx.locale.bind(NS)
            /* 投影生效时，宿主的拖动提交会写进一份屏幕上看不见的顺序，所以这里拦掉并说明原因。 */
            const blockedReorder = async () => {
              ctx.contextMenus.notify(tr('dragBlocked'), true)
            }

            function WorkspaceBrowserCake(props) {
              const able = typeof props.useStore === 'function'
                && typeof props.useWorkspaces === 'function'
                && typeof props.useSessions === 'function'
              if (!able) return Original(props)

              const groupBy = props.useStore(selectGroupBy)
              const orderBy = props.useStore(selectOrderBy)
              const sessions = props.useSessions(selectSessions)
              const pinned = React.useSyncExternalStore(subscribePinned, pinnedSnapshot, pinnedSnapshot)
              const settings = React.useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsSnapshot)
              const items = props.useWorkspaces(selectItems)

              /*
               * 「置顶功能」是总开关：关掉时菜单项隐藏、已置顶的 id 也不再参与排序，
               * 但仍然留在本地集合里，重新打开立刻恢复。
               * 这个开关在设置对象里的键名是 menuPin（历史原因叫 menu*，但它管的是整个功能）。
               */
              const pinnedInUse = React.useMemo(
                () => (settings.menuPin ? pinned : EMPTY_IDS),
                [settings.menuPin, pinned],
              )
              const useRecency = RECENT_ORDER && settings.recent && orderBy === 'updated'

              const projected = React.useMemo(() => {
                if (groupBy !== 'workspace') return items
                return arrangeGroups(items, sessions?.byId, pinnedInUse, useRecency)
              }, [items, sessions, pinnedInUse, groupBy, useRecency])

              /* 哪个工作区里有对话在跑：只看真实会话的 running，折叠与否都算。 */
              const running = React.useMemo(() => {
                const ids = []
                if (!Array.isArray(items)) return ids
                for (const item of items) {
                  const busy = Array.isArray(item.sessionIds)
                    && item.sessionIds.some(id => sessions?.byId?.[id]?.running === true)
                  if (busy) ids.push(item.workspaceId)
                }
                return ids
              }, [items, sessions])

              React.useEffect(() => {
                runningWorkspaces = new Set(running)
                if (requestMark !== null) requestMark()
              }, [running])

              /* 哪个工作区里有宿主确认的未读完成（跑完了还没看）。 */
              // 未读状态：能力固定在该注册上，所以这里的条件调用不会改变 hook 顺序。
              const statuses = typeof props.useSessionStatus === 'function'
                ? props.useSessionStatus(selectStatuses)
                : undefined
              const unread = React.useMemo(() => {
                const ids = []
                if (!Array.isArray(items)) return ids
                for (const item of items) {
                  const has = Array.isArray(item.sessionIds)
                    && item.sessionIds.some(id => statuses?.get?.(id)?.completionUnread === true)
                  if (has) ids.push(item.workspaceId)
                }
                return ids
              }, [items, statuses])

              React.useEffect(() => {
                unreadWorkspaces = new Set(unread)
                if (requestMark !== null) requestMark()
              }, [unread])

              /* 跑完但出错的未读：竖条换成错误色，跟正常未读区分开。 */
              const failed = React.useMemo(() => {
                const ids = []
                if (!Array.isArray(items)) return ids
                for (const item of items) {
                  const has = Array.isArray(item.sessionIds)
                    && item.sessionIds.some(id => statuses?.get?.(id)?.completionFailed === true)
                  if (has) ids.push(item.workspaceId)
                }
                return ids
              }, [items, statuses])

              React.useEffect(() => {
                failedWorkspaces = new Set(failed)
                if (requestMark !== null) requestMark()
              }, [failed])

              /* 同一份快照只投影一次：useSyncExternalStore 每次调用都拿到新对象会无限重渲染。 */
              const useWorkspaces = React.useMemo(() => {
                let lastSnapshot
                let value
                return selector => props.useWorkspaces(state => {
                  if (state !== lastSnapshot) {
                    lastSnapshot = state
                    value = projected === state.items ? state : { ...state, items: projected }
                  }
                  return selector(value)
                })
              }, [projected, props.useWorkspaces])

              /* 顺序被投影改写时，拖动提交就没有意义：拦掉并提示，切到手动排序才能拖。 */
              const reorders = groupBy === 'workspace' && (pinnedInUse.length > 0 || useRecency)
              return Original({
                ...props,
                useWorkspaces,
                ...(reorders ? { insertWorkspaceBefore: blockedReorder } : {}),
              })
            }

            WorkspaceBrowserCake.__dshWorkspaceCake = true
            entry.component = WorkspaceBrowserCake
            installed = { entry, wrapper: WorkspaceBrowserCake, original: Original }
          }

          install()
          const off = ctx.slots.subscribe('sidebar.workspaces', () => install())
          return () => { off(); restore() }
        }, 'dsh-workspace-cake: order projection')

        // ── 行标记：置顶、分隔线、输出中呼吸、未读染色与竖条 ───────────────
        ctx.effect(() => {
          const style = document.createElement('style')
          style.id = 'dsh-workspace-cake-style'
          style.textContent = `
            [data-dsh-cake-boundary] { position: relative; }
            [data-dsh-cake-boundary]::before {
              content: ''; position: absolute; left: 10px; right: 10px; top: -1px; height: 1px;
              background: ${DIVIDER_COLOR};
              pointer-events: none;
            }
            /* 正在输出 / 刚跑完还没看：名字染上蓝紫（行内第三个 span 就是标题容器）。 */
            [data-dsh-cake-running] > span:nth-child(3),
            [data-dsh-cake-unread] > span:nth-child(3) {
              color: ${DYE_COLOR};
            }
            /* 只有正在输出才呼吸；跑完未读就静止染着，读过之后整体褪掉。 */
            @media (prefers-reduced-motion: no-preference) {
              [data-dsh-cake-running] > span:nth-child(3) {
                animation: dsh-cake-name-breath ${BREATH_SECONDS}s ease-in-out infinite;
              }
            }
            @keyframes dsh-cake-name-breath {
              0%, 100% { opacity: ${BREATH_DIM_OPACITY}; }
              50% { opacity: 1; }
            }
            /* 有未读完成：行左侧一条静态短竖条。 */
            [data-dsh-cake-unread] {
              position: relative;
            }
            [data-dsh-cake-unread]::after {
              content: ''; position: absolute; left: 0; top: 7px; bottom: 7px;
              width: ${UNREAD_BAR_WIDTH}px; border-radius: 0 2px 2px 0;
              background: ${UNREAD_BAR_COLOR}; pointer-events: none;
            }
            /* 跑完但出错的未读：竖条换成错误色，跟正常未读分开。 */
            [data-dsh-cake-unread-failed]::after {
              background: var(--dsw-alias-state-error-primary);
            }
            /* 设置页的三个视觉开关：状态写在 <html> 的数据属性上，这里按属性关闭。 */
            html[data-cake-breath="off"] [data-dsh-cake-running] > span:nth-child(3) { animation: none; }
            html[data-cake-unread-bar="off"] [data-dsh-cake-unread]::after { display: none; }
            html[data-cake-unread-dye="off"] [data-dsh-cake-unread]:not([data-dsh-cake-running]) > span:nth-child(3) { color: inherit; }
            html[data-cake-unread-bar="off"] [data-dsh-cake-unread-failed]::after { display: none; }
          `
          document.head.appendChild(style)

          const rows = () => document.querySelectorAll('[data-row-key^="workspace:"]')

          const clear = () => {
            for (const row of rows()) {
              row.removeAttribute('data-dsh-cake-pinned')
              row.removeAttribute('data-dsh-cake-boundary')
              row.removeAttribute('data-dsh-cake-running')
              row.removeAttribute('data-dsh-cake-unread')
              row.removeAttribute('data-dsh-cake-unread-failed')
            }
          }

          /** 结构自检：宿主若改了行的内部结构，染色/呼吸会静默失效，这里提示一次。 */
          let structureWarned = false
          const checkStructure = (row) => {
            if (structureWarned) return
            const titleSlot = row.children[2]
            if (titleSlot !== undefined && titleSlot.tagName === 'SPAN') return
            structureWarned = true
            console.warn('[dsh-workspace-cake] 工作区行的结构与预期不符（第 3 个子节点不是标题容器），名字染色与呼吸可能不生效；宿主升级后请检查 client.js 顶部的结构锚点。')
          }

          /**
           * 置顶集合自清理：工作区被删掉后，别把它的 id 永远留在本地。
           * 依据是工作区快照而不是屏幕上可见的行——某个分组被过滤掉时不该丢置顶。
           */
          let prunedSignature = ''
          const prunePins = () => {
            if (pinnedIds.length === 0) return
            const snapshot = ctx.workspaces.list.getSnapshot()
            if (snapshot.state !== 'idle') return
            const ids = snapshot.items.map(item => item.workspaceId)
            if (ids.length === 0) return
            const signature = ids.join('|')
            if (signature === prunedSignature) return
            prunedSignature = signature
            const alive = new Set(ids)
            const survivors = pinnedIds.filter(id => alive.has(id))
            if (survivors.length === pinnedIds.length) return
            writePinned(survivors)
          }

          const mark = () => {
            clear()
            const pinnedSet = new Set(pinnedIds)
            let seenPinned = false
            let boundaryDrawn = false
            for (const row of rows()) {
              checkStructure(row)
              const key = row.getAttribute('data-row-key') ?? ''
              const workspaceId = key.slice('workspace:'.length)
              if (runningWorkspaces.has(workspaceId)) row.setAttribute('data-dsh-cake-running', '')
              if (unreadWorkspaces.has(workspaceId)) row.setAttribute('data-dsh-cake-unread', '')
              if (failedWorkspaces.has(workspaceId)) row.setAttribute('data-dsh-cake-unread-failed', '')
              if (pinnedSet.has(workspaceId)) {
                row.setAttribute('data-dsh-cake-pinned', '')
                seenPinned = true
                continue
              }
              if (pinnedIds.length > 0 && seenPinned && !boundaryDrawn) {
                row.setAttribute('data-dsh-cake-boundary', '')
                boundaryDrawn = true
              }
            }
            prunePins()
          }

          let queued = false
          const schedule = () => {
            if (queued) return
            queued = true
            setTimeout(() => { queued = false; mark() }, MARK_DELAY_MS)
          }

          /*
           * 只盯侧栏的滚动容器，不盯整页：聊天区每出一张卡片都会让 body 变一次，
           * 那是纯开销。容器在收窄/展开时会重挂，所以每秒比对一次身份，变了就重挂。
           */
          const SCOPE_SELECTOR = '[data-sidebar-scrollport]'
          const observer = new MutationObserver(schedule)
          let scope = null
          const attach = () => {
            const next = document.querySelector(SCOPE_SELECTOR)
            if (next === scope) return
            observer.disconnect()
            scope = next
            if (scope !== null) observer.observe(scope, { childList: true, subtree: true })
            schedule()
          }
          const reattach = setInterval(attach, 1000)
          attach()
          const offPinned = subscribePinned(schedule)
          const offStorage = (() => {
            // 别的页面改了置顶集合：只同步内存并重标，不再写回去，否则两个标签页会互相触发。
            const onStorage = (event) => {
              if (event.key !== PIN_STORAGE_KEY) return
              pinnedIds = readPinned()
              for (const listener of [...pinnedListeners]) listener()
            }
            window.addEventListener('storage', onStorage)
            return () => window.removeEventListener('storage', onStorage)
          })()

          requestMark = schedule
          mark()

          return () => {
            if (requestMark === schedule) requestMark = null
            clearInterval(reattach)
            observer.disconnect()
            scope = null
            offPinned()
            offStorage()
            clear()
            style.remove()
          }
        }, 'dsh-workspace-cake: pin markers')

        // ── 设置页：DSH 设置里左侧列表的「工作区Cake」 ────────────────────
        const SETTING_GROUPS = [
          { title: 'settings.groupVisual', keys: ['breath', 'unreadDye', 'unreadBar'] },
          { title: 'settings.groupMenu', keys: ['menuPin', 'menuTree', 'menuTerminal', 'menuCopyPath', 'menuCursor', 'menuVscode'] },
          { title: 'settings.groupOrder', keys: ['recent'] },
          { title: 'settings.groupCollapse', keys: ['collapse'] },
        ]

        const SETTINGS_CSS = `
          .dsh-cake-settings { display: flex; flex-direction: column; gap: 22px; padding: 4px 0 8px; }
          .dsh-cake-group { display: flex; flex-direction: column; }
          .dsh-cake-group__title {
            margin: 0 0 6px; font-size: 13px; font-weight: 600; line-height: 20px;
            color: var(--dsw-alias-label-secondary);
          }
          .dsh-cake-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 9px 0; }
          .dsh-cake-row + .dsh-cake-row { border-top: 1px solid var(--dsw-alias-border-l1); }
          .dsh-cake-row__text { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
          .dsh-cake-row__label { font-size: 13px; line-height: 20px; color: var(--dsw-alias-label-primary); }
          .dsh-cake-row__desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
          .dsh-cake-switch {
            flex: none; position: relative; width: 36px; height: 20px; padding: 0;
            border: none; border-radius: 999px; cursor: pointer;
            background: var(--dsw-alias-bg-layer-2);
            transition: background-color 120ms var(--ds-ease-in-out, ease);
          }
          .dsh-cake-switch--on { background: var(--dsw-alias-brand-primary); }
          .dsh-cake-switch:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: 2px; }
          .dsh-cake-switch__knob {
            position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%;
            background: #ffffff; transition: transform 120ms var(--ds-ease-in-out, ease);
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
          }
          .dsh-cake-switch--on .dsh-cake-switch__knob { transform: translateX(16px); }
        `

        ctx.effect(() => {
          const style = document.createElement('style')
          style.id = 'dsh-workspace-cake-settings-style'
          style.textContent = SETTINGS_CSS
          document.head.appendChild(style)
          paintSettingsToDom()
          const onStorage = (event) => {
            if (event.key !== SETTINGS_KEY) return
            currentSettings = readSettings()
            publishSettings()
          }
          window.addEventListener('storage', onStorage)
          return () => {
            window.removeEventListener('storage', onStorage)
            style.remove()
            const root = document.documentElement
            delete root.dataset.cakeBreath
            delete root.dataset.cakeUnreadDye
            delete root.dataset.cakeUnreadBar
          }
        }, 'dsh-workspace-cake: settings styles')

        function CakeSwitch({ checked, label, onToggle }) {
          return h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            'aria-label': label,
            className: 'dsh-cake-switch' + (checked ? ' dsh-cake-switch--on' : ''),
            onClick: () => onToggle(!checked),
          }, h('span', { className: 'dsh-cake-switch__knob' }))
        }

        function CakeSettingRow({ itemKey, tr }) {
          const settings = React.useSyncExternalStore(subscribeSettings, settingsSnapshot, settingsSnapshot)
          const label = tr(itemKey + '.label')
          return h('div', { className: 'dsh-cake-row' },
            h('div', { className: 'dsh-cake-row__text' },
              h('div', { className: 'dsh-cake-row__label' }, label),
              h('div', { className: 'dsh-cake-row__desc' }, tr(itemKey + '.desc')),
            ),
            h(CakeSwitch, {
              checked: settings[itemKey] !== false,
              label,
              onToggle: next => writeSettings({ [itemKey]: next }),
            }),
          )
        }

        function CakeSettingsSection() {
          const tr = ctx.locale.bind(NS)
          return h('div', { className: 'dsh-cake-settings' },
            SETTING_GROUPS.map(group => h('section', { key: group.title, className: 'dsh-cake-group' },
              h('h3', { className: 'dsh-cake-group__title' }, tr(group.title)),
              group.keys.map(key => h(CakeSettingRow, { key, itemKey: key, tr })),
            )),
          )
        }

        /** 设置列表里这一项的图标。 */
        const CakeGlyph = ({ size = 16 }) => h('svg', {
          viewBox: '0 0 24 24', width: size, height: size,
          fill: 'none', stroke: 'currentColor', strokeWidth: 1.5,
          strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
        },
          h('path', { d: 'M4 13.5h16v5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z' }),
          h('path', { d: 'M4 13.5c1.9 0 1.9 1.5 3.8 1.5s1.9-1.5 3.8-1.5 1.9 1.5 3.8 1.5 1.9-1.5 4.6-1.5' }),
          h('path', { d: 'M12 13.5V9.5' }),
          h('circle', { cx: 12, cy: 7.5, r: 1.6 }),
        )

        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'dsh-workspace-cake',
          order: 60,
          label: () => t('settingsNav'),
        }, ({ size }) => h(CakeGlyph, { size })))

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-workspace-cake',
          order: 60,
          label: () => t('settingsNav'),
          locale: NS,
        }, CakeSettingsSection))

        // ── 折叠全部工作区：标题栏那个向心箭头按钮（同一个包） ──────────────
        ctx.effect(() => {
          const BUTTON_ID = 'dsh-workspace-cake-fold-button'
          const FOLD_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"'
            + ' stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
            + '<path d="M4 20 9.8 14.2"/><path d="M9.8 14.2H5.6"/><path d="M9.8 14.2V18.4"/>'
            + '<path d="M20 4 14.2 9.8"/><path d="M14.2 9.8h4.2"/><path d="M14.2 9.8V5.6"/></svg>'

          const style = document.createElement('style')
          style.id = 'dsh-workspace-cake-fold-style'
          style.textContent = `
            #${BUTTON_ID} {
              flex: none; display: inline-flex; align-items: center; justify-content: center;
              width: 28px; height: 28px; padding: 0; margin-left: auto;
              border: none; border-radius: var(--dsw-radius-sm);
              background: transparent; color: inherit; cursor: pointer;
            }
            #${BUTTON_ID}:hover { background: var(--dsw-specific-sidebar-nav-item-hover); color: var(--dsw-alias-label-secondary); }
            #${BUTTON_ID}:active { background: var(--dsw-alias-interactive-bg-active); }
            #${BUTTON_ID}:focus-visible { outline: 2px solid var(--dsw-focus-ring-color); outline-offset: -1px; }
            #${BUTTON_ID} svg { display: block; }
          `
          document.head.appendChild(style)

          const HEADER = '[data-sidebar-workspace-header]'
          const WIDE = '[data-sidebar-scrollport]'
          const EXPANDED = '[data-row-key^="workspace:"][aria-expanded="true"]'

          let spacedSlot = null
          const releaseSpacing = () => {
            if (spacedSlot === null) return
            spacedSlot.style.marginLeft = ''
            spacedSlot = null
          }
          const removeButton = () => {
            const existing = document.getElementById(BUTTON_ID)
            if (existing !== null) existing.remove()
            releaseSpacing()
          }
          const foldAll = () => {
            for (const row of document.querySelectorAll(EXPANDED)) row.click()
          }
          const ensure = () => {
            if (!currentSettings.collapse) { removeButton(); return }
            if (document.querySelector(WIDE) === null) { removeButton(); return }
            const header = document.querySelector(HEADER)
            if (header === null) { removeButton(); return }
            const buttons = header.querySelectorAll('button')
            const actions = buttons[buttons.length - 1]?.parentElement
            if (actions === undefined || !header.contains(actions)) { removeButton(); return }

            const label = t('foldAll')
            const existing = document.getElementById(BUTTON_ID)
            if (existing !== null && existing.parentElement === header) {
              existing.title = label
              existing.setAttribute('aria-label', label)
              return
            }
            if (existing !== null) existing.remove()

            const slot = actions.previousElementSibling
            const usable = slot instanceof HTMLElement && slot.tagName === 'DIV' ? slot : null
            if (usable !== null) {
              if (spacedSlot !== usable) { releaseSpacing(); spacedSlot = usable }
              usable.style.marginLeft = '0'
            } else releaseSpacing()

            const button = document.createElement('button')
            button.id = BUTTON_ID
            button.type = 'button'
            button.title = label
            button.setAttribute('aria-label', label)
            button.innerHTML = FOLD_ICON
            button.addEventListener('click', (event) => { event.stopPropagation(); foldAll() })
            header.insertBefore(button, usable ?? actions)
          }

          let queued = false
          const schedule = () => {
            if (queued) return
            queued = true
            setTimeout(() => { queued = false; ensure() }, MARK_DELAY_MS)
          }
          const observer = new MutationObserver(schedule)
          let scope = null
          const attach = () => {
            const next = document.querySelector(HEADER)?.parentElement ?? null
            if (next === scope) return
            observer.disconnect()
            scope = next
            if (scope !== null) observer.observe(scope, { childList: true, subtree: true })
            schedule()
          }
          const reattach = setInterval(attach, 1000)
          const offSettings = subscribeSettings(schedule)
          attach()
          ensure()

          return () => {
            clearInterval(reattach)
            offSettings()
            observer.disconnect()
            scope = null
            removeButton()
            style.remove()
          }
        }, 'dsh-workspace-cake: fold button')

        // 图标最后注册：它们出现在槽位里就说明上面每一步都跑通了（也是本插件唯一可被检查的落点）。
        ctx.effect(() => ctx.slots.inject('contextMenu.icon', function* () {
          yield ctx.slots.register({ name: 'contextMenu.icon', key: 'dsh-workspace-cake.tree' }, TreeIcon)
          yield ctx.slots.register({ name: 'contextMenu.icon', key: 'dsh-workspace-cake.terminal' }, TerminalIcon)
          yield ctx.slots.register({ name: 'contextMenu.icon', key: 'dsh-workspace-cake.copy' }, CopyIcon)
          yield ctx.slots.register({ name: 'contextMenu.icon', key: 'dsh-workspace-cake.application' }, ApplicationIcon)
        }), 'dsh-workspace-cake: menu icons')
      },
    }
  },
})