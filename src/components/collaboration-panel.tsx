import { ArrowRight, ArrowUpRightFromSquare, ChevronDown, ChevronsCollapseHorizontal, ChevronsExpandHorizontal, CircleCheck, CirclePlayFill, CircleStopFill, CircleXmark, FolderOpen, Layers, PencilToSquare, Persons, Plus, TrashBin } from '@gravity-ui/icons'
import { invoke } from '@tauri-apps/api/core'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from 'valtio-define'
import { store } from '@/store'
import { toast } from '@/utils'

type CollaborationMode = 'serial' | 'parallel'
type NodeStatus = 'idle' | 'running' | 'done' | 'failed'
type RunState = 'idle' | 'running' | 'done' | 'failed'
type RunMode = 'master' | 'auto'
type CollabView = 'workflows' | 'creator'

interface CanvasNode {
  id: string
  instanceId: string
  x: number
  y: number
  /** 该节点的直接子节点如何执行；父子之间始终按顺序依赖 */
  childrenMode: CollaborationMode
  /** 该实例负责的粗粒度任务描述 */
  task: string
  /** 该节点完成后交付给下游的产物（文本、文件路径等） */
  result: string
}

interface CanvasEdge {
  id: string
  parentId: string
  childId: string
}

interface CollabTaskStart {
  sessionId: string
  workspaceId: string
}

interface CollabTaskStatus {
  done: boolean
  result: string
}

interface CollabPortAllocation {
  instanceId: string
  port: number
}

interface WorkflowSummary {
  id: string
  name: string
  workspace: string
  nodeCount: number
  updatedAt: number
}

interface WorkflowTemplateNode {
  id: string
  x: number
  y: number
  childrenMode: CollaborationMode
  /** 角色文案的 i18n key，打开模板时解析为节点任务 */
  taskKey: string
}

interface WorkflowTemplate {
  id: string
  nameKey: string
  descKey: string
  nodes: WorkflowTemplateNode[]
  edges: CanvasEdge[]
}

const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: 'code-writing',
    nameKey: 'launcher.collaboration.template_name_code_writing',
    descKey: 'launcher.collaboration.template_desc_code_writing',
    nodes: [
      { id: 'tpl-code-plan', x: 7760, y: 7720, childrenMode: 'parallel', taskKey: 'launcher.collaboration.template_task_code_writing_1' },
      { id: 'tpl-code-dev', x: 7760, y: 7960, childrenMode: 'parallel', taskKey: 'launcher.collaboration.template_task_code_writing_2' },
      { id: 'tpl-code-review', x: 7760, y: 8200, childrenMode: 'parallel', taskKey: 'launcher.collaboration.template_task_code_writing_3' },
      { id: 'tpl-code-summary', x: 7760, y: 8440, childrenMode: 'parallel', taskKey: 'launcher.collaboration.template_task_code_writing_4' },
    ],
    edges: [
      { id: 'edge-code-plan-dev', parentId: 'tpl-code-plan', childId: 'tpl-code-dev' },
      { id: 'edge-code-dev-review', parentId: 'tpl-code-dev', childId: 'tpl-code-review' },
      { id: 'edge-code-review-summary', parentId: 'tpl-code-review', childId: 'tpl-code-summary' },
    ],
  },
  {
    id: 'doc-writing',
    nameKey: 'launcher.collaboration.template_name_doc_writing',
    descKey: 'launcher.collaboration.template_desc_doc_writing',
    nodes: [
      { id: 'tpl-doc-outline', x: 7760, y: 7720, childrenMode: 'parallel', taskKey: 'launcher.collaboration.template_task_doc_writing_1' },
      { id: 'tpl-doc-write', x: 7760, y: 7960, childrenMode: 'parallel', taskKey: 'launcher.collaboration.template_task_doc_writing_2' },
      { id: 'tpl-doc-proofread', x: 7760, y: 8200, childrenMode: 'parallel', taskKey: 'launcher.collaboration.template_task_doc_writing_3' },
    ],
    edges: [
      { id: 'edge-doc-outline-write', parentId: 'tpl-doc-outline', childId: 'tpl-doc-write' },
      { id: 'edge-doc-write-proofread', parentId: 'tpl-doc-write', childId: 'tpl-doc-proofread' },
    ],
  },
  {
    id: 'code-review',
    nameKey: 'launcher.collaboration.template_name_code_review',
    descKey: 'launcher.collaboration.template_desc_code_review',
    nodes: [
      { id: 'tpl-review-analyze', x: 7760, y: 7720, childrenMode: 'parallel', taskKey: 'launcher.collaboration.template_task_code_review_1' },
      { id: 'tpl-review-check', x: 7760, y: 7960, childrenMode: 'parallel', taskKey: 'launcher.collaboration.template_task_code_review_2' },
      { id: 'tpl-review-fix', x: 7760, y: 8200, childrenMode: 'parallel', taskKey: 'launcher.collaboration.template_task_code_review_3' },
    ],
    edges: [
      { id: 'edge-review-analyze-check', parentId: 'tpl-review-analyze', childId: 'tpl-review-check' },
      { id: 'edge-review-check-fix', parentId: 'tpl-review-check', childId: 'tpl-review-fix' },
    ],
  },
]

interface PersistedCollabGraph {
  version: number
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  viewport: { left: number, top: number }
  workspace?: string
  runMode?: RunMode
  world?: { left: number, top: number, right: number, bottom: number }
  zoom?: number
}

function buildGraphPayload(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  viewport: { left: number, top: number },
  workspace: string,
  runMode: RunMode,
  world: { left: number, top: number, right: number, bottom: number },
  zoom: number,
): PersistedCollabGraph {
  return { version: 1, nodes, edges, viewport, workspace, runMode, world, zoom }
}

/** 协作页统一下拉框：原生 select 去默认箭头，统一高度/边框/焦点态并附加自定义箭头 */
function SelectField({ className = '', children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className={`relative inline-flex ${className}`}>
      <select
        {...props}
        className="h-[30px] w-full cursor-pointer appearance-none rounded-md border border-[var(--launcher-border)] bg-white/80 pl-2.5 pr-7 text-xs text-[var(--launcher-ink)] outline-none transition-colors hover:border-[var(--launcher-brand)] focus:border-[var(--launcher-brand)]"
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-[var(--launcher-muted)]" />
    </div>
  )
}

const NODE_WIDTH = 184
const NODE_HEIGHT = 86
/** 默认画布大小（不大，按需向四个方向扩展） */
const WORLD_BASE = 2000
/** 点击边界“+”按钮时单次扩展的画布尺寸 */
const WORLD_GROW_STEP = 800
/** 缩放范围与滚轮步进 */
const ZOOM_MIN = 0.25
const ZOOM_MAX = 3
const ZOOM_STEP = 1.1
/** 视口外仍保持挂载的余量，避免拖动时节点在边缘闪烁 */
const VIEWPORT_MARGIN = 800
/** 轮询 DSH 会话进度的间隔；任务完成由 turn/end 事件驱动，不靠轮询判定结果 */
const POLL_INTERVAL_MS = 2_000

const STATUS_DOT: Record<NodeStatus, string> = {
  idle: '#a6b1ba',
  running: '#d9a441',
  done: '#3f9b78',
  failed: '#d9605c',
}

/** 为所有节点生成初始“待运行”状态表；缺失键统一视为 idle，避免空表被当作“不可调度” */
function idleStatuses(nodes: CanvasNode[]): Record<string, NodeStatus> {
  return Object.fromEntries(nodes.map(node => [node.id, 'idle' as NodeStatus]))
}

/**
 * 计算当前可以启动的节点：父节点全部完成，且串行父节点下排在更前的兄弟节点
 * 也已完成后才能启动。根节点没有父节点，默认全部并行启动。
 */
function computeReadyNodeIds(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  statuses: Record<string, NodeStatus>,
): string[] {
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const parentsByChild = new Map<string, string[]>()
  const siblingsByParent = new Map<string, string[]>()
  for (const edge of edges) {
    const parents = parentsByChild.get(edge.childId) ?? []
    parents.push(edge.parentId)
    parentsByChild.set(edge.childId, parents)
    const siblings = siblingsByParent.get(edge.parentId) ?? []
    siblings.push(edge.childId)
    siblingsByParent.set(edge.parentId, siblings)
  }
  return nodes
    .filter((node) => {
      if ((statuses[node.id] ?? 'idle') !== 'idle')
        return false
      const parents = parentsByChild.get(node.id) ?? []
      if (parents.some(parentId => statuses[parentId] !== 'done'))
        return false
      for (const parentId of parents) {
        const parent = nodeById.get(parentId)
        if (!parent || parent.childrenMode !== 'serial')
          continue
        const siblings = siblingsByParent.get(parentId) ?? []
        const index = siblings.indexOf(node.id)
        for (let i = 0; i < index; i++) {
          if (statuses[siblings[i]] !== 'done')
            return false
        }
      }
      return true
    })
    .map(node => node.id)
}

export default function CollaborationPanel() {
  const { t } = useTranslation()
  const { registry, runningInstanceIds } = useStore(store.launcher)
  const canvasRef = useRef<HTMLDivElement>(null)
  const [nodes, setNodes] = useState<CanvasNode[]>([])
  const [edges, setEdges] = useState<CanvasEdge[]>([])
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null)
  const [draggingNode, setDraggingNode] = useState<{ id: string, offsetX: number, offsetY: number } | null>(null)
  const [panDrag, setPanDrag] = useState<{ startX: number, startY: number, startScrollLeft: number, startScrollTop: number } | null>(null)
  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 0, height: 0 })
  const [nodeStatus, setNodeStatus] = useState<Record<string, NodeStatus>>({})
  const [runState, setRunState] = useState<RunState>('idle')
  const [confirmClear, setConfirmClear] = useState(false)
  const [workspacePath, setWorkspacePath] = useState('')
  const [runMode, setRunMode] = useState<RunMode>('master')
  const [collabView, setCollabView] = useState<CollabView>('workflows')
  const [workflowNavOpen, setWorkflowNavOpen] = useState(true)
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([])
  const [savingWorkflow, setSavingWorkflow] = useState(false)
  const [workflowName, setWorkflowName] = useState('')
  const [confirmDeleteWorkflowId, setConfirmDeleteWorkflowId] = useState<string | null>(null)
  const [workflowActionBusy, setWorkflowActionBusy] = useState(false)
  const [worldExt, setWorldExt] = useState({ left: 0, top: 0, right: 0, bottom: 0 })
  const [edgeHover, setEdgeHover] = useState({ left: false, top: false, right: false, bottom: false })
  const [zoom, setZoom] = useState(1)

  /** 编排引擎的权威图数据源：所有修改先写 ref，再同步到 state，避免事件里读到旧值 */
  const graphRef = useRef({ nodes, edges })
  const statusRef = useRef<Record<string, NodeStatus>>({})
  const sessionsRef = useRef<Record<string, string>>({})
  const pollTimersRef = useRef<Map<string, number>>(new Map())
  /** 初始视口：恢复上次位置；没有记录时保持 null（居中） */
  const initialViewportRef = useRef<{ left: number, top: number } | null>(null)
  const viewportAppliedRef = useRef(false)
  const viewportRef = useRef({ left: 0, top: 0 })
  const saveTimerRef = useRef<number | null>(null)
  /** 只在真实变更后写盘，避免 StrictMode 模拟卸载时把空画布提前持久化 */
  const dirtyRef = useRef(false)
  const clearTimerRef = useRef<number | null>(null)
  const workspaceRef = useRef('')
  const runModeRef = useRef<RunMode>('master')
  const worldExtRef = useRef({ left: 0, top: 0, right: 0, bottom: 0 })
  const zoomRef = useRef(1)

  const worldWidth = WORLD_BASE + worldExt.left + worldExt.right
  const worldHeight = WORLD_BASE + worldExt.top + worldExt.bottom

  function commitGraph(nextNodes: CanvasNode[], nextEdges: CanvasEdge[], persist = true) {
    graphRef.current = { nodes: nextNodes, edges: nextEdges }
    setNodes(nextNodes)
    setEdges(nextEdges)
    if (persist)
      scheduleSave()
  }

  function commitStatuses(next: Record<string, NodeStatus>) {
    statusRef.current = next
    setNodeStatus(next)
  }

  function commitSessions(next: Record<string, string>) {
    sessionsRef.current = next
  }

  function commitWorldExt(next: { left: number, top: number, right: number, bottom: number }, persist = true) {
    worldExtRef.current = next
    setWorldExt(next)
    if (persist)
      scheduleSave()
  }

  /** 把画布视口定位到节点包围盒中心（空画布则居中到默认画布中心） */
  function centerOnNodes() {
    const canvas = canvasRef.current
    const width = canvas?.clientWidth ?? 1200
    const height = canvas?.clientHeight ?? 800
    const ext = worldExtRef.current
    const currentZoom = zoomRef.current
    const worldW = (WORLD_BASE + ext.left + ext.right) * currentZoom
    const worldH = (WORLD_BASE + ext.top + ext.bottom) * currentZoom
    const nodesList = graphRef.current.nodes
    if (nodesList.length === 0) {
      initialViewportRef.current = {
        left: Math.max(0, (worldW - width) / 2),
        top: Math.max(0, (worldH - height) / 2),
      }
    }
    else {
      const minX = Math.min(...nodesList.map(node => node.x))
      const maxX = Math.max(...nodesList.map(node => node.x + NODE_WIDTH))
      const minY = Math.min(...nodesList.map(node => node.y))
      const maxY = Math.max(...nodesList.map(node => node.y + NODE_HEIGHT))
      initialViewportRef.current = {
        left: Math.max(0, Math.min(((minX + maxX) / 2 - width / 2) * currentZoom, Math.max(0, worldW - width))),
        top: Math.max(0, Math.min(((minY + maxY) / 2 - height / 2) * currentZoom, Math.max(0, worldH - height))),
      }
    }
    viewportAppliedRef.current = false
  }

  /** 当节点超出默认画布范围时，自动把画布向对应方向扩展以容纳节点 */
  function fitWorldToNodes(padding = 240) {
    const nodesList = graphRef.current.nodes
    if (nodesList.length === 0)
      return
    const ext = worldExtRef.current
    const maxX = Math.max(...nodesList.map(node => node.x + NODE_WIDTH))
    const maxY = Math.max(...nodesList.map(node => node.y + NODE_HEIGHT))
    const rightLimit = WORLD_BASE + ext.right
    const bottomLimit = WORLD_BASE + ext.bottom
    const next = { ...ext }
    if (maxX + padding > rightLimit)
      next.right += maxX + padding - rightLimit
    if (maxY + padding > bottomLimit)
      next.bottom += maxY + padding - bottomLimit
    if (next.right !== ext.right || next.bottom !== ext.bottom)
      commitWorldExt(next)
  }

  /** 点击画布边界“+”按钮：把画布向该方向扩展一格 */
  function expandWorld(direction: 'left' | 'top' | 'right' | 'bottom') {
    const canvas = canvasRef.current
    const ext = worldExtRef.current
    const next = { ...ext }
    if (direction === 'left') {
      next.left += WORLD_GROW_STEP
      // 向左扩展：现有节点整体右移，同时滚动位置左移，保持视觉不变
      commitGraph(
        graphRef.current.nodes.map(node => ({ ...node, x: node.x + WORLD_GROW_STEP })),
        graphRef.current.edges,
      )
      if (canvas)
        canvas.scrollLeft = Math.max(0, canvas.scrollLeft - WORLD_GROW_STEP * zoomRef.current)
    }
    if (direction === 'top') {
      next.top += WORLD_GROW_STEP
      commitGraph(
        graphRef.current.nodes.map(node => ({ ...node, y: node.y + WORLD_GROW_STEP })),
        graphRef.current.edges,
      )
      if (canvas)
        canvas.scrollTop = Math.max(0, canvas.scrollTop - WORLD_GROW_STEP * zoomRef.current)
    }
    if (direction === 'right')
      next.right += WORLD_GROW_STEP
    if (direction === 'bottom')
      next.bottom += WORLD_GROW_STEP
    commitWorldExt(next)
    setEdgeHover({ left: false, top: false, right: false, bottom: false })
  }

  function commitWorkspace(path: string) {
    workspaceRef.current = path
    setWorkspacePath(path)
    scheduleSave()
  }

  function commitRunMode(mode: RunMode) {
    runModeRef.current = mode
    setRunMode(mode)
    scheduleSave()
  }

  async function persistGraph() {
    try {
      await invoke('collab_save_graph', {
        graph: buildGraphPayload(
          graphRef.current.nodes,
          graphRef.current.edges,
          viewportRef.current,
          workspaceRef.current,
          runModeRef.current,
          worldExtRef.current,
          zoomRef.current,
        ),
      })
    }
    catch {
      // 持久化失败不阻塞编排，下一次变更会再次尝试
    }
  }

  function scheduleSave() {
    dirtyRef.current = true
    if (saveTimerRef.current !== null)
      window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void persistGraph()
    }, 400)
  }

  const instanceById = new Map(registry.instances.map(instance => [instance.id, instance]))
  const nodeById = new Map(nodes.map(node => [node.id, node]))
  const runningIds = new Set(runningInstanceIds)
  const parentsByChild = new Map<string, string[]>()
  const childrenByParent = new Map<string, string[]>()
  for (const edge of edges) {
    const parents = parentsByChild.get(edge.childId) ?? []
    parents.push(edge.parentId)
    parentsByChild.set(edge.childId, parents)
    const children = childrenByParent.get(edge.parentId) ?? []
    children.push(edge.childId)
    childrenByParent.set(edge.parentId, children)
  }

  const selectedNode = selectedNodeId ? nodeById.get(selectedNodeId) ?? null : null
  const selectedInstance = selectedNode ? instanceById.get(selectedNode.instanceId) ?? null : null
  const selectedStatus = selectedNode ? nodeStatus[selectedNode.id] ?? 'idle' : 'idle'
  const selectedParentNodes = selectedNode
    ? (parentsByChild.get(selectedNode.id) ?? []).map(parentId => nodeById.get(parentId)).filter((node): node is CanvasNode => Boolean(node))
    : []
  const selectedChildren = selectedNode ? (childrenByParent.get(selectedNode.id) ?? []) : []
  const selectedIds = new Set(nodes.map(node => node.instanceId))
  const doneCount = nodes.filter(node => nodeStatus[node.id] === 'done').length
  const visibleNodes = nodes.filter((node) => {
    if (viewport.width === 0)
      return true
    const contentLeft = viewport.left / zoom
    const contentTop = viewport.top / zoom
    const contentWidth = viewport.width / zoom
    const contentHeight = viewport.height / zoom
    return node.x + NODE_WIDTH >= contentLeft - VIEWPORT_MARGIN
      && node.x <= contentLeft + contentWidth + VIEWPORT_MARGIN
      && node.y + NODE_HEIGHT >= contentTop - VIEWPORT_MARGIN
      && node.y <= contentTop + contentHeight + VIEWPORT_MARGIN
  })
  const visibleNodeIds = new Set(visibleNodes.map(node => node.id))
  const visibleEdges = edges.filter(edge => visibleNodeIds.has(edge.parentId) && visibleNodeIds.has(edge.childId))
  const hasParallelHomeConflict = selectedNode?.childrenMode === 'parallel'
    && selectedChildren.length >= 2
    && new Set(selectedChildren.map((childId) => {
      const childNode = nodeById.get(childId)
      return childNode ? instanceById.get(childNode.instanceId)?.dshHome.toLowerCase() : undefined
    }).filter(Boolean)).size < selectedChildren.length

  useEffect(() => {
    if (!draggingNode)
      return
    const activeDrag = draggingNode
    function handlePointerMove(event: PointerEvent) {
      const canvas = canvasRef.current
      if (!canvas)
        return
      const rect = canvas.getBoundingClientRect()
      const ext = worldExtRef.current
      const maxX = WORLD_BASE + ext.left + ext.right - NODE_WIDTH
      const maxY = WORLD_BASE + ext.top + ext.bottom - NODE_HEIGHT
      const currentZoom = zoomRef.current
      const x = Math.max(0, Math.min(maxX, (event.clientX - rect.left + canvas.scrollLeft - activeDrag.offsetX) / currentZoom))
      const y = Math.max(0, Math.min(maxY, (event.clientY - rect.top + canvas.scrollTop - activeDrag.offsetY) / currentZoom))
      commitGraph(
        graphRef.current.nodes.map(node => node.id === activeDrag.id ? { ...node, x, y } : node),
        graphRef.current.edges,
      )
    }
    function handlePointerUp() {
      setDraggingNode(null)
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
    // 拖拽期间只移动单节点，事件监听在拖拽开始时挂载即可，无需随 commitGraph 重跑。
    // eslint-disable-next-line react/exhaustive-deps
  }, [draggingNode])

  useEffect(() => {
    if (!panDrag)
      return
    const activePan = panDrag
    function handlePointerMove(event: PointerEvent) {
      const canvas = canvasRef.current
      if (!canvas)
        return
      canvas.scrollLeft = activePan.startScrollLeft - (event.clientX - activePan.startX)
      canvas.scrollTop = activePan.startScrollTop - (event.clientY - activePan.startY)
    }
    function handlePointerUp() {
      setPanDrag(null)
    }
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [panDrag])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas)
      return
    let resizeObserver: ResizeObserver | null = null
    const applyViewport = () => {
      if (viewportAppliedRef.current)
        return
      if (canvas.clientWidth === 0 || canvas.clientHeight === 0)
        return
      viewportAppliedRef.current = true
      const ext = worldExtRef.current
      const currentZoom = zoomRef.current
      const maxScrollLeft = Math.max(0, (WORLD_BASE + ext.left + ext.right) * currentZoom - canvas.clientWidth)
      const maxScrollTop = Math.max(0, (WORLD_BASE + ext.top + ext.bottom) * currentZoom - canvas.clientHeight)
      const saved = initialViewportRef.current
      if (saved) {
        canvas.scrollLeft = Math.max(0, Math.min(saved.left, maxScrollLeft))
        canvas.scrollTop = Math.max(0, Math.min(saved.top, maxScrollTop))
      }
      else {
        canvas.scrollLeft = Math.max(0, (WORLD_BASE + ext.left + ext.right) * currentZoom / 2 - canvas.clientWidth / 2)
        canvas.scrollTop = Math.max(0, (WORLD_BASE + ext.top + ext.bottom) * currentZoom / 2 - canvas.clientHeight / 2)
      }
    }
    // 画布常驻挂载（切换视图时用 hidden 隐藏），等第一次可见（尺寸非 0）再定位
    // 视口；打开工作流/模板时会重置 viewportAppliedRef 以重新居中。
    resizeObserver = new ResizeObserver(applyViewport)
    resizeObserver.observe(canvas)
    return () => resizeObserver.disconnect()
  }, [])

  // Ctrl + 滚轮：以光标为锚点缩放画布（native 监听以允许 preventDefault）
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas)
      return
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey)
        return
      event.preventDefault()
      const rect = canvas.getBoundingClientRect()
      const pointerX = event.clientX - rect.left
      const pointerY = event.clientY - rect.top
      const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
      const nextZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomRef.current * factor))
      if (nextZoom === zoomRef.current)
        return
      const ratio = nextZoom / zoomRef.current
      const ext = worldExtRef.current
      const worldW = WORLD_BASE + ext.left + ext.right
      const worldH = WORLD_BASE + ext.top + ext.bottom
      zoomRef.current = nextZoom
      setZoom(nextZoom)
      canvas.scrollLeft = Math.max(0, Math.min(pointerX - (pointerX - canvas.scrollLeft) * ratio, worldW * nextZoom - canvas.clientWidth))
      canvas.scrollTop = Math.max(0, Math.min(pointerY - (pointerY - canvas.scrollTop) * ratio, worldH * nextZoom - canvas.clientHeight))
      scheduleSave()
    }
    canvas.addEventListener('wheel', handleWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', handleWheel)
    // 监听器只在挂载时绑定一次；辅助函数只操作 ref，不作为依赖
    // eslint-disable-next-line react/exhaustive-deps
  }, [])

  useEffect(() => {
    let cancelled = false
    void invoke<PersistedCollabGraph | null>('collab_load_graph')
      .then((saved) => {
        if (cancelled || !saved)
          return
        if (Array.isArray(saved.nodes) && saved.nodes.length > 0) {
          const restoredEdges = Array.isArray(saved.edges) ? saved.edges : []
          graphRef.current = { nodes: saved.nodes, edges: restoredEdges }
          setNodes(saved.nodes)
          setEdges(restoredEdges)
        }
        const savedViewport = saved.viewport && typeof saved.viewport.left === 'number' && typeof saved.viewport.top === 'number'
          ? saved.viewport
          : null
        if (typeof saved.workspace === 'string') {
          workspaceRef.current = saved.workspace
          setWorkspacePath(saved.workspace)
        }
        if (saved.runMode === 'master' || saved.runMode === 'auto') {
          runModeRef.current = saved.runMode
          setRunMode(saved.runMode)
        }
        const restoredWorld = saved.world && typeof saved.world.left === 'number' && typeof saved.world.top === 'number' && typeof saved.world.right === 'number' && typeof saved.world.bottom === 'number'
          ? saved.world
          : { left: 0, top: 0, right: 0, bottom: 0 }
        worldExtRef.current = restoredWorld
        setWorldExt(restoredWorld)
        if (typeof saved.zoom === 'number' && saved.zoom > 0) {
          zoomRef.current = saved.zoom
          setZoom(saved.zoom)
        }
        fitWorldToNodes()
        if (savedViewport) {
          initialViewportRef.current = savedViewport
        }
        else {
          centerOnNodes()
        }
        if (viewportAppliedRef.current && savedViewport) {
          const canvas = canvasRef.current
          if (canvas) {
            const ext = worldExtRef.current
            canvas.scrollLeft = Math.max(0, Math.min(savedViewport.left, WORLD_BASE + ext.left + ext.right - canvas.clientWidth))
            canvas.scrollTop = Math.max(0, Math.min(savedViewport.top, WORLD_BASE + ext.top + ext.bottom - canvas.clientHeight))
          }
        }
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
    // 启动时一次性恢复画布；辅助函数只操作 ref，不作为依赖
    // eslint-disable-next-line react/exhaustive-deps
  }, [])

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current)
        clearTimerRef.current = null
      }
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
      if (dirtyRef.current) {
        void invoke('collab_save_graph', {
          graph: buildGraphPayload(
            graphRef.current.nodes,
            graphRef.current.edges,
            viewportRef.current,
            workspaceRef.current,
            runModeRef.current,
            worldExtRef.current,
            zoomRef.current,
          ),
        }).catch(() => {})
      }
    }
  }, [])

  useEffect(() => {
    if (collabView !== 'workflows')
      return
    // 进入工作流列表时刷新一次；函数本身不作为依赖

    void refreshWorkflows()
  }, [collabView])

  function addInstanceToCanvas(instanceId: string, x: number, y: number) {
    const usedInstanceIds = new Set(graphRef.current.nodes.map(node => node.instanceId))
    if (usedInstanceIds.has(instanceId))
      return
    const id = `node-${instanceId}-${Date.now()}`
    commitGraph(
      [...graphRef.current.nodes, { id, instanceId, x, y, childrenMode: 'parallel', task: '', result: '' }],
      graphRef.current.edges,
    )
    setSelectedNodeId(id)
  }

  function handleCanvasDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault()
    const instanceId = event.dataTransfer.getData('application/x-dsh-instance')
    const canvas = canvasRef.current
    if (!instanceId || !canvas)
      return
    const rect = canvas.getBoundingClientRect()
    const currentZoom = zoomRef.current
    addInstanceToCanvas(
      instanceId,
      (event.clientX - rect.left + canvas.scrollLeft) / currentZoom - NODE_WIDTH / 2,
      (event.clientY - rect.top + canvas.scrollTop) / currentZoom - NODE_HEIGHT / 2,
    )
  }

  function handleNodePointerDown(event: React.PointerEvent<HTMLDivElement>, node: CanvasNode) {
    if (event.button !== 0)
      return
    if ((event.target as HTMLElement).closest('[data-node-handle]'))
      return
    const canvas = canvasRef.current
    const rect = canvas?.getBoundingClientRect()
    if (!canvas || !rect)
      return
    setSelectedNodeId(node.id)
    const currentZoom = zoomRef.current
    setDraggingNode({
      id: node.id,
      offsetX: event.clientX - rect.left + canvas.scrollLeft - node.x * currentZoom,
      offsetY: event.clientY - rect.top + canvas.scrollTop - node.y * currentZoom,
    })
  }

  function connectToNode(childId: string) {
    if (!connectingFrom || connectingFrom === childId)
      return
    const currentEdges = graphRef.current.edges
    if (currentEdges.some(edge => edge.parentId === connectingFrom && edge.childId === childId)) {
      setConnectingFrom(null)
      return
    }
    if (currentEdges.some(edge => edge.childId === childId)) {
      setConnectingFrom(null)
      return
    }
    function reachesNode(currentId: string, targetId: string, visited = new Set<string>()): boolean {
      if (currentId === targetId)
        return true
      if (visited.has(currentId))
        return false
      visited.add(currentId)
      return currentEdges.filter(edge => edge.parentId === currentId).some(edge => reachesNode(edge.childId, targetId, visited))
    }
    const wouldCreateCycle = reachesNode(childId, connectingFrom)
    if (!wouldCreateCycle)
      commitGraph(graphRef.current.nodes, [...currentEdges, { id: `edge-${connectingFrom}-${childId}`, parentId: connectingFrom, childId }])
    setConnectingFrom(null)
  }

  function updateNodeField(nodeId: string, field: 'task' | 'result', value: string) {
    commitGraph(
      graphRef.current.nodes.map(node => node.id === nodeId ? { ...node, [field]: value } : node),
      graphRef.current.edges,
    )
  }

  function removeSelectedNode() {
    if (!selectedNodeId || runState === 'running')
      return
    cancelPoll(selectedNodeId)
    const nextNodes = graphRef.current.nodes.filter(node => node.id !== selectedNodeId)
    const nextEdges = graphRef.current.edges.filter(edge => edge.parentId !== selectedNodeId && edge.childId !== selectedNodeId)
    commitGraph(nextNodes, nextEdges)
    const remainingStatuses = { ...statusRef.current }
    delete remainingStatuses[selectedNodeId]
    commitStatuses(remainingStatuses)
    const remainingSessions = { ...sessionsRef.current }
    delete remainingSessions[selectedNodeId]
    commitSessions(remainingSessions)
    setSelectedNodeId(null)
  }

  function startRun() {
    if (runModeRef.current === 'master') {
      void startMasterRun()
      return
    }
    const { nodes: currentNodes, edges: currentEdges } = graphRef.current
    if (currentNodes.length === 0) {
      toast(t('launcher.collaboration.run_validation_empty'), { variant: 'warning', placement: 'bottom end' })
      return
    }
    const missingTask = currentNodes.filter(node => !node.task.trim())
    if (missingTask.length > 0) {
      toast(t('launcher.collaboration.run_validation_missing_task', { count: missingTask.length }), { variant: 'warning', placement: 'bottom end' })
      return
    }
    if (currentNodes.some(node => !node.instanceId)) {
      toast(t('launcher.collaboration.run_validation_unassigned_instance'), { variant: 'warning', placement: 'bottom end' })
      return
    }
    if (currentNodes.some(node => !instanceById.has(node.instanceId))) {
      toast(t('launcher.collaboration.run_validation_unknown_instance'), { variant: 'warning', placement: 'bottom end' })
      return
    }
    const homeByNodeId = new Map<string, string>()
    for (const node of currentNodes) {
      const instance = instanceById.get(node.instanceId)
      if (instance)
        homeByNodeId.set(node.id, instance.dshHome.toLowerCase())
    }
    const parentsByNode = new Map<string, string[]>()
    const childrenByNode = new Map<string, string[]>()
    for (const edge of currentEdges) {
      const parents = parentsByNode.get(edge.childId) ?? []
      parents.push(edge.parentId)
      parentsByNode.set(edge.childId, parents)
      const children = childrenByNode.get(edge.parentId) ?? []
      children.push(edge.childId)
      childrenByNode.set(edge.parentId, children)
    }
    const parallelGroups: string[][] = []
    const roots = currentNodes.filter(node => (parentsByNode.get(node.id)?.length ?? 0) === 0)
    if (roots.length > 1)
      parallelGroups.push(roots.map(node => node.id))
    for (const node of currentNodes) {
      const children = childrenByNode.get(node.id) ?? []
      if (children.length > 1 && node.childrenMode === 'parallel')
        parallelGroups.push(children)
    }
    const hasHomeConflict = parallelGroups.some(group => new Set(group.map(id => homeByNodeId.get(id))).size < group.length)
    if (hasHomeConflict) {
      toast(t('launcher.collaboration.run_validation_home_conflict'), { variant: 'warning', placement: 'bottom end' })
      return
    }
    commitSessions({})
    commitStatuses(idleStatuses(currentNodes))
    setRunState('running')
    startReadyNodes()
  }

  async function pickWorkspace() {
    const path = await invoke<string | null>('choose_collab_workspace')
    if (path)
      commitWorkspace(path)
  }

  async function waitForAllPorts(instanceIds: string[]): Promise<boolean> {
    const uniqueIds = [...new Set(instanceIds)]
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      await store.launcher.refreshRunning()
      const ports = store.launcher.runningInstancePorts
      if (uniqueIds.every(id => typeof ports[id] === 'number'))
        return true
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
    return false
  }

  function buildContractInput(nodes: CanvasNode[], edges: CanvasEdge[], portsById: Map<string, number>) {
    const nodeById = new Map(nodes.map(node => [node.id, node]))
    const parentsByNode = new Map<string, string[]>()
    const childrenByNode = new Map<string, string[]>()
    for (const edge of edges) {
      const parents = parentsByNode.get(edge.childId) ?? []
      parents.push(edge.parentId)
      parentsByNode.set(edge.childId, parents)
      const children = childrenByNode.get(edge.parentId) ?? []
      children.push(edge.childId)
      childrenByNode.set(edge.parentId, children)
    }
    return {
      workspace: workspaceRef.current,
      agents: nodes.map((node) => {
        const instance = instanceById.get(node.instanceId)
        const parents = parentsByNode.get(node.id) ?? []
        const parentNode = parents[0] ? nodeById.get(parents[0]) : undefined
        const children = (childrenByNode.get(node.id) ?? [])
          .map(childId => nodeById.get(childId)?.instanceId)
          .filter((instanceId): instanceId is string => Boolean(instanceId))
        return {
          instanceId: node.instanceId,
          name: instance?.name ?? node.instanceId,
          role: node.task,
          port: portsById.get(node.instanceId) ?? 0,
          parentInstanceId: parentNode?.instanceId ?? null,
          children,
        }
      }),
    }
  }

  /** 主代理的初始指令：告知工作区、契约文件与职责，引导其阅读契约后待命 */
  function buildMasterSeed(masterNode: CanvasNode): string {
    const instance = instanceById.get(masterNode.instanceId)
    const contractPath = `${workspaceRef.current.replace(/[\\/]+$/, '')}\\.dsh-collab.json`
    const manualPath = `${workspaceRef.current.replace(/[\\/]+$/, '')}\\.dsh-collab-api.md`
    return t('launcher.collaboration.master_seed', {
      name: instance?.name ?? masterNode.instanceId,
      workspace: workspaceRef.current,
      contractPath,
      manualPath,
      role: masterNode.task.trim() || t('launcher.collaboration.master_role_unset'),
    })
  }

  /**
   * 主代理驱动模式：先为参与实例分配固定端口，把端口/角色/父子关系写入
   * 工作区契约文件，再启动所有实例（子 Agent 窗口最小化），最后打开主代理
   * 窗口交给用户驱动；启动器不自动向节点下发任务。
   */
  async function startMasterRun() {
    const { nodes: currentNodes, edges: currentEdges } = graphRef.current
    if (currentNodes.length === 0) {
      toast(t('launcher.collaboration.run_validation_empty'), { variant: 'warning', placement: 'bottom end' })
      return
    }
    // 主代理驱动模式不要求每个节点都填任务：主代理可在对话中为子代理分配职责
    if (!workspaceRef.current.trim()) {
      toast(t('launcher.collaboration.workspace_required'), { variant: 'warning', placement: 'bottom end' })
      return
    }
    if (currentNodes.some(node => !node.instanceId)) {
      toast(t('launcher.collaboration.run_validation_unassigned_instance'), { variant: 'warning', placement: 'bottom end' })
      return
    }
    if (currentNodes.some(node => !instanceById.has(node.instanceId))) {
      toast(t('launcher.collaboration.run_validation_unknown_instance'), { variant: 'warning', placement: 'bottom end' })
      return
    }
    // 所有 Agent 同时运行，任何共享 DSH Home 都不能参与
    const homes = new Set<string>()
    for (const node of currentNodes) {
      const instance = instanceById.get(node.instanceId)
      if (!instance)
        continue
      const home = instance.dshHome.toLowerCase()
      if (homes.has(home)) {
        toast(t('launcher.collaboration.run_validation_home_conflict'), { variant: 'warning', placement: 'bottom end' })
        return
      }
      homes.add(home)
    }
    const childIds = new Set(currentEdges.map(edge => edge.childId))
    const roots = currentNodes.filter(node => !childIds.has(node.id))
    const masterNode = roots[0] ?? currentNodes[0]

    // 1. 实例尚未启动，先一次性分配互不冲突的固定端口
    let allocations: CollabPortAllocation[]
    try {
      allocations = await invoke<CollabPortAllocation[]>('collab_allocate_ports', {
        instanceIds: currentNodes.map(node => node.instanceId),
      })
    }
    catch {
      toast(t('launcher.collaboration.port_allocate_failed'), { variant: 'danger', placement: 'bottom end' })
      return
    }
    const portsById = new Map(allocations.map(item => [item.instanceId, item.port]))

    // 2. 端口固定后先写契约文件（启动前失败可干净退出，不残留实例）
    try {
      const contractPath = await invoke<string>('collab_write_contract', {
        input: buildContractInput(currentNodes, currentEdges, portsById),
      })
      toast(t('launcher.collaboration.contract_written', { path: contractPath }), { variant: 'accent', placement: 'bottom end' })
    }
    catch {
      toast(t('launcher.collaboration.contract_failed'), { variant: 'danger', placement: 'bottom end' })
      return
    }

    // 3. 启动所有实例（子 Agent 窗口最小化，使用分配的固定端口）
    commitSessions({})
    const runningStatuses = idleStatuses(currentNodes)
    for (const node of currentNodes)
      runningStatuses[node.id] = 'running'
    commitStatuses(runningStatuses)
    setRunState('running')
    let launchFailed = false
    for (const node of currentNodes) {
      const minimized = node.id !== masterNode.id
      try {
        await store.launcher.launchInstance(node.instanceId, false, minimized, portsById.get(node.instanceId))
      }
      catch {
        launchFailed = true
      }
    }
    if (launchFailed) {
      toast(t('launcher.collaboration.launch_failed'), { variant: 'danger', placement: 'bottom end' })
      setRunState('failed')
      return
    }
    if (!await waitForAllPorts(currentNodes.map(node => node.instanceId))) {
      toast(t('launcher.collaboration.port_wait_timeout'), { variant: 'danger', placement: 'bottom end' })
      setRunState('failed')
      return
    }
    // 4. 等全部实例就绪后，给主代理下发初始指令并聚焦窗口
    try {
      await invoke<CollabTaskStart>('collab_start_task', {
        instanceId: masterNode.instanceId,
        task: buildMasterSeed(masterNode),
      })
    }
    catch {
      toast(t('launcher.collaboration.master_seed_failed'), { variant: 'warning', placement: 'bottom end' })
    }
    void focusInstanceWithRetry(masterNode.instanceId)
  }

  function stopRun() {
    for (const nodeId of Object.keys(statusRef.current)) {
      if (statusRef.current[nodeId] === 'running')
        void cancelRemoteTask(nodeId)
      cancelPoll(nodeId)
    }
    commitSessions({})
    commitStatuses(idleStatuses(graphRef.current.nodes))
    setRunState('idle')
  }

  function startReadyNodes() {
    const ready = computeReadyNodeIds(graphRef.current.nodes, graphRef.current.edges, statusRef.current)
    if (ready.length === 0) {
      finalizeRun()
      return
    }
    const next = { ...statusRef.current }
    for (const id of ready)
      next[id] = 'running'
    commitStatuses(next)
    for (const id of ready)
      void dispatchTask(id)
  }

  function finalizeRun() {
    const { nodes: currentNodes } = graphRef.current
    const statuses = statusRef.current
    const failed = currentNodes.some(node => statuses[node.id] === 'failed')
    const allDone = currentNodes.length > 0 && currentNodes.every(node => statuses[node.id] === 'done')
    if (allDone && runModeRef.current === 'auto') {
      // 生命周期规则（自动流水线）：全部成功即停止参与实例并释放端口；
      // 失败/审批保留现场。主代理驱动模式由用户继续交互，不自动停止。
      const instanceIds = new Set(currentNodes.map(node => node.instanceId))
      for (const instanceId of instanceIds)
        void store.launcher.stopInstance(instanceId)
    }
    setRunState(failed ? 'failed' : allDone ? 'done' : 'running')
  }

  /** 组装下发到 DSH 的提示词：节点任务 + 已完成的父节点产物交接 */
  function buildTaskPrompt(nodeId: string): string {
    const node = graphRef.current.nodes.find(item => item.id === nodeId)
    if (!node)
      return ''
    const parents = graphRef.current.edges
      .filter(edge => edge.childId === nodeId)
      .map(edge => graphRef.current.nodes.find(item => item.id === edge.parentId))
      .filter((parent): parent is CanvasNode => Boolean(parent))
    const handoffs = parents
      .filter(parent => statusRef.current[parent.id] === 'done' && parent.result.trim() !== '')
      .map((parent) => {
        const instance = instanceById.get(parent.instanceId)
        return `- ${instance?.name ?? parent.instanceId}: ${parent.result.trim()}`
      })
    if (handoffs.length === 0)
      return node.task
    return `${node.task}\n\n${t('launcher.collaboration.prompt_upstream_title')}\n${handoffs.join('\n')}`
  }

  async function dispatchTask(nodeId: string) {
    const node = graphRef.current.nodes.find(item => item.id === nodeId)
    const instance = node ? instanceById.get(node.instanceId) : undefined
    if (!node || !instance) {
      failNode(nodeId)
      return
    }
    try {
      await store.launcher.launchInstance(instance.id)
      const started = await invoke<CollabTaskStart>('collab_start_task', {
        instanceId: instance.id,
        task: buildTaskPrompt(nodeId),
      })
      if (statusRef.current[nodeId] !== 'running') {
        void invoke('collab_cancel_task', { instanceId: instance.id, sessionId: started.sessionId }).catch(() => {})
        return
      }
      commitSessions({ ...sessionsRef.current, [nodeId]: started.sessionId })
      schedulePoll(nodeId)
    }
    catch (error) {
      const message = String(error)
      toast(message.includes('agent-busy') ? t('launcher.collaboration.agent_busy') : t('launcher.collaboration.launch_failed'), { variant: 'danger', placement: 'bottom end' })
      failNode(nodeId)
    }
  }

  function schedulePoll(nodeId: string) {
    if (statusRef.current[nodeId] !== 'running')
      return
    const sessionId = sessionsRef.current[nodeId]
    const node = graphRef.current.nodes.find(item => item.id === nodeId)
    const instance = node ? instanceById.get(node.instanceId) : undefined
    if (!sessionId || !instance)
      return
    cancelPoll(nodeId)
    const timer = window.setTimeout(() => {
      void (async () => {
        if (statusRef.current[nodeId] !== 'running')
          return
        try {
          const status = await invoke<CollabTaskStatus>('collab_poll_task', {
            instanceId: instance.id,
            sessionId,
          })
          if (statusRef.current[nodeId] !== 'running')
            return
          if (status.done) {
            if (status.result.trim() !== '') {
              commitGraph(
                graphRef.current.nodes.map(item => item.id === nodeId ? { ...item, result: status.result } : item),
                graphRef.current.edges,
              )
            }
            completeNode(nodeId)
          }
          else {
            schedulePoll(nodeId)
          }
        }
        catch {
          if (statusRef.current[nodeId] === 'running') {
            toast(t('launcher.collaboration.poll_failed'), { variant: 'danger', placement: 'bottom end' })
            failNode(nodeId)
          }
        }
      })()
    }, POLL_INTERVAL_MS)
    pollTimersRef.current.set(nodeId, timer)
  }

  function cancelPoll(nodeId: string) {
    const timer = pollTimersRef.current.get(nodeId)
    if (timer !== undefined) {
      window.clearTimeout(timer)
      pollTimersRef.current.delete(nodeId)
    }
  }

  async function cancelRemoteTask(nodeId: string) {
    const sessionId = sessionsRef.current[nodeId]
    const node = graphRef.current.nodes.find(item => item.id === nodeId)
    const instance = node ? instanceById.get(node.instanceId) : undefined
    if (!sessionId || !instance)
      return
    try {
      await invoke('collab_cancel_task', { instanceId: instance.id, sessionId })
    }
    catch {
      // 实例可能已停止或会话已结束，取消失败不影响本地编排状态
    }
    const nextSessions = { ...sessionsRef.current }
    delete nextSessions[nodeId]
    commitSessions(nextSessions)
  }

  function completeNode(nodeId: string) {
    cancelPoll(nodeId)
    void cancelRemoteTask(nodeId)
    const next: Record<string, NodeStatus> = { ...statusRef.current, [nodeId]: 'done' }
    commitStatuses(next)
    startReadyNodes()
  }

  function failNode(nodeId: string) {
    if (statusRef.current[nodeId] !== 'running')
      return
    cancelPoll(nodeId)
    void cancelRemoteTask(nodeId)
    const next: Record<string, NodeStatus> = { ...statusRef.current, [nodeId]: 'failed' }
    commitStatuses(next)
    if (!Object.values(next).includes('running'))
      finalizeRun()
  }

  async function openInstanceWindow(instanceId: string) {
    try {
      await invoke('focus_instance_window', { id: instanceId })
    }
    catch {
      await store.launcher.launchInstance(instanceId)
    }
  }

  /** 主代理窗口启动后可能被其它窗口盖住，多次尝试置前 */
  async function focusInstanceWithRetry(instanceId: string) {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        await invoke('focus_instance_window', { id: instanceId })
        return
      }
      catch {
        await new Promise(resolve => setTimeout(resolve, 400))
      }
    }
  }

  /** 顶部节点选择：选中后把画布平移到该节点居中并打开属性栏 */
  function focusNode(nodeId: string) {
    const node = nodeById.get(nodeId)
    const canvas = canvasRef.current
    if (!node || !canvas)
      return
    const ext = worldExtRef.current
    const currentZoom = zoomRef.current
    setSelectedNodeId(nodeId)
    canvas.scrollLeft = Math.max(0, Math.min((node.x + NODE_WIDTH / 2 - canvas.clientWidth / 2) * currentZoom, (WORLD_BASE + ext.left + ext.right) * currentZoom - canvas.clientWidth))
    canvas.scrollTop = Math.max(0, Math.min((node.y + NODE_HEIGHT / 2 - canvas.clientHeight / 2) * currentZoom, (WORLD_BASE + ext.top + ext.bottom) * currentZoom - canvas.clientHeight))
  }

  function clearCanvas() {
    if (runState === 'running') {
      toast(t('launcher.collaboration.clear_blocked'), { variant: 'warning', placement: 'bottom end' })
      return
    }
    if (!confirmClear) {
      setConfirmClear(true)
      if (clearTimerRef.current !== null)
        window.clearTimeout(clearTimerRef.current)
      clearTimerRef.current = window.setTimeout(() => {
        clearTimerRef.current = null
        setConfirmClear(false)
      }, 3000)
      return
    }
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current)
      clearTimerRef.current = null
    }
    setConfirmClear(false)
    commitGraph([], [])
    commitStatuses({})
    commitSessions({})
    setSelectedNodeId(null)
    toast(t('launcher.collaboration.canvas_cleared'), { variant: 'accent', placement: 'bottom end' })
  }

  async function refreshWorkflows() {
    try {
      setWorkflows(await invoke<WorkflowSummary[]>('collab_list_workflows'))
    }
    catch {
      setWorkflows([])
    }
  }

  async function saveCurrentWorkflow() {
    const name = workflowName.trim()
    if (!name || workflowActionBusy)
      return
    setWorkflowActionBusy(true)
    try {
      await invoke<WorkflowSummary>('collab_save_workflow', {
        name,
        graph: buildGraphPayload(
          graphRef.current.nodes,
          graphRef.current.edges,
          viewportRef.current,
          workspaceRef.current,
          runModeRef.current,
          worldExtRef.current,
          zoomRef.current,
        ),
      })
      setSavingWorkflow(false)
      setWorkflowName('')
      toast(t('launcher.collaboration.workflow_saved'), { variant: 'accent', placement: 'bottom end' })
      await refreshWorkflows()
    }
    catch {
      toast(t('launcher.collaboration.workflow_save_failed'), { variant: 'danger', placement: 'bottom end' })
    }
    finally {
      setWorkflowActionBusy(false)
    }
  }

  /** 把命名工作流的图数据恢复到画布（同步更新 ref，便于随后直接启用） */
  function restoreWorkflowGraph(graph: PersistedCollabGraph) {
    const restoredEdges = Array.isArray(graph.edges) ? graph.edges : []
    graphRef.current = { nodes: graph.nodes, edges: restoredEdges }
    setNodes(graph.nodes)
    setEdges(restoredEdges)
    workspaceRef.current = typeof graph.workspace === 'string' ? graph.workspace : ''
    setWorkspacePath(workspaceRef.current)
    const restoredMode = graph.runMode === 'auto' ? 'auto' : 'master'
    runModeRef.current = restoredMode
    setRunMode(restoredMode)
    const restoredWorld = graph.world && typeof graph.world.left === 'number' && typeof graph.world.top === 'number' && typeof graph.world.right === 'number' && typeof graph.world.bottom === 'number'
      ? graph.world
      : { left: 0, top: 0, right: 0, bottom: 0 }
    worldExtRef.current = restoredWorld
    setWorldExt(restoredWorld)
    if (typeof graph.zoom === 'number' && graph.zoom > 0) {
      zoomRef.current = graph.zoom
      setZoom(graph.zoom)
    }
    // 打开工作流时把视口居中到节点内容，而不是回到可能陈旧的左上角位置
    fitWorldToNodes()
    centerOnNodes()
    dirtyRef.current = true
    scheduleSave()
  }

  async function openWorkflow(workflowId: string, runNow: boolean) {
    if (workflowActionBusy)
      return
    if (runState === 'running') {
      toast(t('launcher.collaboration.workflow_switch_blocked'), { variant: 'warning', placement: 'bottom end' })
      return
    }
    setWorkflowActionBusy(true)
    try {
      const graph = await invoke<PersistedCollabGraph>('collab_load_workflow', { id: workflowId })
      restoreWorkflowGraph(graph)
      setCollabView('creator')
      if (runNow)
        startRun()
    }
    catch {
      toast(t('launcher.collaboration.workflow_open_failed'), { variant: 'danger', placement: 'bottom end' })
    }
    finally {
      setWorkflowActionBusy(false)
    }
  }

  /** 打开预制模板：节点不带实例，进入创作面板后由用户分配 */
  function openTemplate(template: WorkflowTemplate) {
    if (runState === 'running') {
      toast(t('launcher.collaboration.workflow_switch_blocked'), { variant: 'warning', placement: 'bottom end' })
      return
    }
    // 模板内容摆放在默认画布中心附近，避免打开后超出小画布范围
    const spacing = 240
    const startY = WORLD_BASE / 2 - ((template.nodes.length - 1) * spacing) / 2
    const nodes: CanvasNode[] = template.nodes.map((node, index) => ({
      id: node.id,
      instanceId: '',
      x: WORLD_BASE / 2 - NODE_WIDTH / 2,
      y: startY + index * spacing,
      childrenMode: node.childrenMode,
      task: t(node.taskKey),
      result: '',
    }))
    graphRef.current = { nodes, edges: template.edges }
    setNodes(nodes)
    setEdges(template.edges)
    const zeroExt = { left: 0, top: 0, right: 0, bottom: 0 }
    worldExtRef.current = zeroExt
    setWorldExt(zeroExt)
    setSelectedNodeId(null)
    commitStatuses(idleStatuses(nodes))
    commitSessions({})
    dirtyRef.current = true
    setCollabView('creator')
    centerOnNodes()
    scheduleSave()
  }

  function assignNodeInstance(instanceId: string) {
    if (!selectedNodeId)
      return
    commitGraph(
      graphRef.current.nodes.map(node => node.id === selectedNodeId ? { ...node, instanceId } : node),
      graphRef.current.edges,
    )
  }

  async function deleteWorkflow(workflowId: string) {
    if (confirmDeleteWorkflowId !== workflowId) {
      setConfirmDeleteWorkflowId(workflowId)
      window.setTimeout(() => {
        setConfirmDeleteWorkflowId(current => current === workflowId ? null : current)
      }, 3000)
      return
    }
    setConfirmDeleteWorkflowId(null)
    if (workflowActionBusy)
      return
    setWorkflowActionBusy(true)
    try {
      await invoke('collab_delete_workflow', { id: workflowId })
      toast(t('launcher.collaboration.workflow_deleted'), { variant: 'accent', placement: 'bottom end' })
      await refreshWorkflows()
    }
    catch {
      toast(t('launcher.collaboration.workflow_delete_failed'), { variant: 'danger', placement: 'bottom end' })
    }
    finally {
      setWorkflowActionBusy(false)
    }
  }

  return (
    <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-[var(--launcher-canvas)]">
      <header className="flex-none border-b border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-5 py-3 md:px-7">
        <div className="flex min-h-8 items-center justify-between gap-5">
          <div className="flex min-w-0 items-center gap-3">
            <span className="hidden flex-none text-[11px] font-semibold uppercase tracking-wide text-[var(--launcher-brand)] sm:inline">{t('launcher.collaboration.eyebrow')}</span>
            <h1 className="m-0 flex-none text-xl font-semibold">{t('launcher.collaboration.title')}</h1>
            <span className="hidden min-w-0 truncate text-xs text-[var(--launcher-muted)] lg:block">{t('launcher.collaboration.description')}</span>
          </div>
          <div className="flex flex-none items-center gap-2">
            <SelectField
              aria-label={t('launcher.collaboration.jump_to_node')}
              value=""
              className="max-w-[180px] flex-none"
              onChange={(event) => {
                if (event.target.value)
                  focusNode(event.target.value)
              }}
            >
              <option value="" disabled>{t('launcher.collaboration.jump_placeholder')}</option>
              {nodes.map((node) => {
                const instance = node.instanceId ? instanceById.get(node.instanceId) : undefined
                const status = nodeStatus[node.id] ?? 'idle'
                const label = [
                  instance?.name ?? t('launcher.collaboration.unknown_instance'),
                  node.task.trim() || t(`launcher.collaboration.node_status_${status}`),
                ].join(' · ')
                return <option key={node.id} value={node.id}>{label}</option>
              })}
            </SelectField>
            <button
              type="button"
              disabled={nodes.length === 0}
              title={runState === 'running' ? t('launcher.collaboration.clear_blocked') : confirmClear ? t('launcher.collaboration.clear_canvas_confirm') : t('launcher.collaboration.clear_canvas')}
              className={`flex flex-none items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${confirmClear ? 'border-danger/50 bg-danger/10 text-danger' : 'border-[var(--launcher-border)] bg-white/70 text-[var(--launcher-ink)] hover:bg-white'}`}
              onClick={clearCanvas}
            >
              <TrashBin className="size-3.5" />
              <span className="hidden md:inline">{confirmClear ? t('launcher.collaboration.clear_canvas_confirm') : t('launcher.collaboration.clear_canvas')}</span>
            </button>
            {savingWorkflow
              ? (
                  <div className="flex h-[30px] flex-none items-center gap-1 rounded-md border border-[var(--launcher-brand)] bg-white/80 px-2">
                    <input
                      autoFocus
                      value={workflowName}
                      onChange={event => setWorkflowName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter')
                          void saveCurrentWorkflow()
                        if (event.key === 'Escape') {
                          setSavingWorkflow(false)
                          setWorkflowName('')
                        }
                      }}
                      placeholder={t('launcher.collaboration.workflow_name_placeholder')}
                      className="w-[130px] bg-transparent text-xs outline-none"
                    />
                    <button
                      type="button"
                      disabled={!workflowName.trim() || workflowActionBusy}
                      aria-label={t('launcher.collaboration.workflow_save_confirm')}
                      className="text-[var(--launcher-brand)] disabled:opacity-40"
                      onClick={() => { void saveCurrentWorkflow() }}
                    >
                      <CircleCheck className="size-4" />
                    </button>
                    <button
                      type="button"
                      aria-label={t('launcher.collaboration.workflow_save_cancel')}
                      className="text-[var(--launcher-muted)]"
                      onClick={() => {
                        setSavingWorkflow(false)
                        setWorkflowName('')
                      }}
                    >
                      <CircleXmark className="size-4" />
                    </button>
                  </div>
                )
              : (
                  <button
                    type="button"
                    title={t('launcher.collaboration.save_workflow')}
                    className="flex flex-none items-center gap-1.5 rounded-md border border-[var(--launcher-border)] bg-white/70 px-2.5 py-1.5 text-xs hover:bg-white"
                    onClick={() => setSavingWorkflow(true)}
                  >
                    <Plus className="size-3.5" />
                    <span className="hidden md:inline">{t('launcher.collaboration.save_workflow')}</span>
                  </button>
                )}
            <span
              title={t('launcher.collaboration.run_hint')}
              className={`hidden flex-none rounded-full border px-3 py-1 text-xs sm:inline-flex ${runState === 'failed' ? 'border-danger/40 bg-danger/5 text-danger' : runState === 'done' ? 'border-[#3f9b78]/40 bg-[#3f9b78]/10 text-[#2d7a5c]' : runState === 'running' ? 'border-[#d9a441]/45 bg-[#d9a441]/10 text-[#9a6f16]' : 'border-[var(--launcher-border)] bg-white/60 text-[var(--launcher-muted)]'}`}
            >
              {runState === 'running'
                ? t('launcher.collaboration.run_summary', { done: doneCount, total: nodes.length })
                : t(`launcher.collaboration.run_state_${runState}`)}
            </span>
            <button
              type="button"
              title={t('launcher.collaboration.run_hint')}
              className={`flex flex-none items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${runState === 'running' ? 'border border-[var(--launcher-border)] bg-white/70 hover:bg-white' : 'bg-[var(--launcher-brand)] text-white hover:bg-[var(--launcher-brand-strong)]'}`}
              onClick={runState === 'running' ? stopRun : startRun}
            >
              {runState === 'running' ? <CircleStopFill className="size-4" /> : <CirclePlayFill className="size-4" />}
              <span className="hidden md:inline">{runState === 'running' ? t('launcher.collaboration.stop_workflow') : t('launcher.collaboration.run_workflow')}</span>
            </button>
            <span className="hidden flex-none rounded-full border border-[var(--launcher-border)] bg-white/60 px-3 py-1 text-xs text-[var(--launcher-muted)] sm:inline-flex">
              {t('launcher.collaboration.canvas_count', { count: nodes.length })}
            </span>
          </div>
        </div>

        <div className="mt-3 flex min-w-0 items-center gap-3">
          <div className="flex flex-none flex-col gap-1.5 rounded-md border border-[var(--launcher-border)] bg-white/60 px-2.5 py-2">
            <label className="flex items-center gap-2 text-xs text-[var(--launcher-muted)]">
              <span className="flex-none">{t('launcher.collaboration.run_mode_label')}</span>
              <SelectField
                value={runMode}
                className="flex-none"
                onChange={event => commitRunMode(event.target.value as RunMode)}
              >
                <option value="master">{t('launcher.collaboration.run_mode_master')}</option>
                <option value="auto">{t('launcher.collaboration.run_mode_auto')}</option>
              </SelectField>
            </label>
            <button
              type="button"
              title={workspacePath || t('launcher.collaboration.workspace_pick')}
              className="flex items-center gap-1.5 rounded-md border border-[var(--launcher-border)] bg-white/80 px-2 py-1 text-xs text-[var(--launcher-ink)] hover:border-[var(--launcher-brand)]"
              onClick={() => { void pickWorkspace() }}
            >
              <FolderOpen className="size-3.5 flex-none text-[var(--launcher-brand)]" />
              <span className="max-w-[220px] truncate">{workspacePath || t('launcher.collaboration.workspace_pick')}</span>
            </button>
          </div>
          <div className="flex min-w-0 items-end gap-3 overflow-x-auto pb-0.5" aria-label={t('launcher.collaboration.instance_shelf')}>
            {registry.instances.length === 0
              ? <div className="rounded-md border border-dashed border-[var(--launcher-border)] px-4 py-3 text-sm text-[var(--launcher-muted)]">{t('launcher.collaboration.no_instances')}</div>
              : registry.instances.map(instance => (
                  <div
                    key={instance.id}
                    draggable={!selectedIds.has(instance.id)}
                    title={selectedIds.has(instance.id) ? t('launcher.collaboration.already_added') : t('launcher.collaboration.drag_hint')}
                    className={`flex h-[54px] min-w-[146px] flex-none cursor-grab flex-col justify-between rounded-md border px-3 py-2 text-left transition-colors active:cursor-grabbing ${selectedIds.has(instance.id) ? 'border-[var(--launcher-brand)]/35 bg-[var(--launcher-selected)]/60 opacity-70' : 'border-[var(--launcher-border)] bg-white/70 hover:border-[var(--launcher-brand)] hover:bg-white'}`}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = 'copy'
                      event.dataTransfer.setData('application/x-dsh-instance', instance.id)
                    }}
                  >
                    <div className="truncate text-sm font-medium">{instance.name}</div>
                    <div className="flex items-center justify-between gap-2 text-[11px] text-[var(--launcher-muted)]">
                      <span className="truncate">
                        {t('launcher.collaboration.profile')}
                        {' '}
                        {instance.profile}
                      </span>
                      <span className={`size-1.5 flex-none rounded-full ${runningIds.has(instance.id) ? 'bg-[#3f9b78]' : 'bg-[#a6b1ba]'}`} />
                    </div>
                  </div>
                ))}
          </div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav
          aria-label={t('launcher.collaboration.subnav_label')}
          className={`flex-none border-r border-[var(--launcher-border)] bg-[var(--launcher-sidebar)] transition-[width] duration-200 ${workflowNavOpen ? 'w-[176px]' : 'w-[44px]'}`}
        >
          <div className="flex h-full flex-col items-stretch gap-1 p-1.5">
            <button
              type="button"
              aria-pressed={collabView === 'workflows'}
              className={`flex h-[36px] items-center gap-2 rounded-md px-2 text-xs ${collabView === 'workflows' ? 'bg-[var(--launcher-selected)] font-medium text-[var(--launcher-brand-strong)]' : 'text-[var(--launcher-muted)] hover:bg-white'}`}
              onClick={() => setCollabView('workflows')}
            >
              <Layers className="size-4 flex-none" />
              {workflowNavOpen && <span className="truncate">{t('launcher.collaboration.nav_workflows')}</span>}
            </button>
            <button
              type="button"
              aria-pressed={collabView === 'creator'}
              className={`flex h-[36px] items-center gap-2 rounded-md px-2 text-xs ${collabView === 'creator' ? 'bg-[var(--launcher-selected)] font-medium text-[var(--launcher-brand-strong)]' : 'text-[var(--launcher-muted)] hover:bg-white'}`}
              onClick={() => setCollabView('creator')}
            >
              <PencilToSquare className="size-4 flex-none" />
              {workflowNavOpen && <span className="truncate">{t('launcher.collaboration.nav_creator')}</span>}
            </button>
            <div className="flex-1" />
            <button
              type="button"
              title={workflowNavOpen ? t('launcher.collaboration.nav_collapse') : t('launcher.collaboration.nav_expand')}
              className="flex h-[36px] items-center justify-center gap-2 rounded-md text-[var(--launcher-muted)] hover:bg-white"
              onClick={() => setWorkflowNavOpen(open => !open)}
            >
              {workflowNavOpen ? <ChevronsCollapseHorizontal className="size-4 flex-none" /> : <ChevronsExpandHorizontal className="size-4 flex-none" />}
              {workflowNavOpen && <span className="truncate text-xs">{t('launcher.collaboration.nav_collapse')}</span>}
            </button>
          </div>
        </nav>
        <div className={`relative min-h-[460px] min-w-0 flex-1 ${collabView === 'creator' ? '' : 'hidden'}`}>
          <div
            ref={canvasRef}
            className={`absolute inset-0 overflow-auto ${panDrag ? 'cursor-grabbing' : 'cursor-default'}`}
            onDragOver={event => event.preventDefault()}
            onDrop={handleCanvasDrop}
            onContextMenu={event => event.preventDefault()}
            onPointerMove={(event) => {
              const canvas = canvasRef.current
              if (!canvas || draggingNode || panDrag)
                return
              const rect = canvas.getBoundingClientRect()
              const threshold = 48
              setEdgeHover({
                left: canvas.scrollLeft <= 1 && event.clientX - rect.left < threshold,
                top: canvas.scrollTop <= 1 && event.clientY - rect.top < threshold,
                right: canvas.scrollLeft >= canvas.scrollWidth - canvas.clientWidth - 1 && rect.right - event.clientX < threshold,
                bottom: canvas.scrollTop >= canvas.scrollHeight - canvas.clientHeight - 1 && rect.bottom - event.clientY < threshold,
              })
            }}
            onPointerLeave={() => setEdgeHover({ left: false, top: false, right: false, bottom: false })}
            onScroll={() => {
              const canvas = canvasRef.current
              if (!canvas)
                return
              setViewport({ left: canvas.scrollLeft, top: canvas.scrollTop, width: canvas.clientWidth, height: canvas.clientHeight })
              viewportRef.current = { left: canvas.scrollLeft, top: canvas.scrollTop }
              scheduleSave()
            }}
          >
            <div
              className="relative"
              style={{ width: worldWidth * zoom, height: worldHeight * zoom }}
            >
              <div
                className="absolute left-0 top-0 bg-[radial-gradient(circle_at_1px_1px,var(--launcher-border)_1px,transparent_0)] [background-size:22px_22px]"
                style={{ width: worldWidth, height: worldHeight, transform: `scale(${zoom})`, transformOrigin: '0 0' }}
                onPointerDown={(event) => {
                  if (event.button !== 2 || event.target !== event.currentTarget)
                    return
                  const canvas = canvasRef.current
                  if (!canvas)
                    return
                  setPanDrag({
                    startX: event.clientX,
                    startY: event.clientY,
                    startScrollLeft: canvas.scrollLeft,
                    startScrollTop: canvas.scrollTop,
                  })
                }}
                onPointerUp={(event) => {
                  if ((event.target as HTMLElement).closest('[data-node-handle]'))
                    return
                  setConnectingFrom(null)
                }}
              >
                <svg className="pointer-events-none absolute inset-0 size-full overflow-visible" aria-hidden="true">
                  <defs>
                    <marker id="collaboration-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                      <path d="M0,0 L8,4 L0,8 z" fill="var(--launcher-brand)" />
                    </marker>
                  </defs>
                  {visibleEdges.map((edge) => {
                    const parent = nodeById.get(edge.parentId)
                    const child = nodeById.get(edge.childId)
                    if (!parent || !child)
                      return null
                    const startX = parent.x + NODE_WIDTH / 2
                    const startY = parent.y + NODE_HEIGHT
                    const endX = child.x + NODE_WIDTH / 2
                    const endY = child.y
                    const curve = Math.max(32, Math.abs(endY - startY) * 0.45)
                    return <path key={edge.id} d={`M ${startX} ${startY} C ${startX} ${startY + curve}, ${endX} ${endY - curve}, ${endX} ${endY}`} fill="none" stroke="var(--launcher-brand)" strokeWidth="2" markerEnd="url(#collaboration-arrow)" />
                  })}
                </svg>

                {visibleNodes.map((node) => {
                  const instance = node.instanceId ? instanceById.get(node.instanceId) : undefined
                  const isSelected = selectedNodeId === node.id
                  const isConnecting = connectingFrom === node.id
                  const childCount = childrenByParent.get(node.id)?.length ?? 0
                  const status = nodeStatus[node.id] ?? 'idle'
                  const statusLabel = t(`launcher.collaboration.node_status_${status}`)
                  const taskPreview = node.task.trim()
                  return (
                    <div
                      key={node.id}
                      title={statusLabel}
                      className={`absolute flex h-[86px] w-[184px] touch-none flex-col justify-between rounded-md border bg-[var(--launcher-surface)] px-3 py-3 shadow-[0_8px_20px_rgba(42,70,90,0.1)] ${isSelected ? 'border-[var(--launcher-brand)] ring-2 ring-[var(--launcher-brand)]/20' : status === 'running' ? 'border-[#d9a441]/70 ring-2 ring-[#d9a441]/25' : status === 'done' ? 'border-[#3f9b78]/60' : status === 'failed' ? 'border-[#d9605c]/70 ring-2 ring-[#d9605c]/20' : 'border-[var(--launcher-border)]'} ${isConnecting ? 'ring-2 ring-[var(--launcher-brand)]/40' : ''}`}
                      style={{ left: node.x, top: node.y }}
                      onPointerDown={event => handleNodePointerDown(event, node)}
                      onClick={() => setSelectedNodeId(node.id)}
                    >
                      <button
                        type="button"
                        data-node-handle="target"
                        aria-label={t('launcher.collaboration.connect_target', { name: instance?.name ?? '' })}
                        className={`absolute -top-2 left-1/2 grid size-4 -translate-x-1/2 place-items-center rounded-full border border-[var(--launcher-brand)] bg-[var(--launcher-surface)] text-[var(--launcher-brand)] transition-opacity hover:opacity-100 focus:opacity-100 ${isSelected || connectingFrom ? 'opacity-100' : 'opacity-0'}`}
                        onPointerUp={(event) => {
                          event.stopPropagation()
                          connectToNode(node.id)
                        }}
                      >
                        <span className="size-1 rounded-full bg-current" />
                      </button>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="size-2 flex-none rounded-full" style={{ backgroundColor: STATUS_DOT[status] }} />
                        <span className="truncate text-sm font-medium">{instance?.name ?? (node.instanceId ? t('launcher.collaboration.unknown_instance') : t('launcher.collaboration.node_unassigned_instance'))}</span>
                      </div>
                      <div className="truncate text-[11px] text-[var(--launcher-muted)]">
                        {taskPreview || (childCount > 0
                          ? t('launcher.collaboration.node_children_summary', { count: childCount, mode: t(`launcher.collaboration.mode_${node.childrenMode}`) })
                          : t('launcher.collaboration.node_status_draft'))}
                      </div>
                      <button
                        type="button"
                        data-node-handle="source"
                        aria-label={t('launcher.collaboration.connect_source', { name: instance?.name ?? '' })}
                        className={`absolute -bottom-2 left-1/2 grid size-4 -translate-x-1/2 place-items-center rounded-full border border-[var(--launcher-brand)] bg-[var(--launcher-surface)] text-[var(--launcher-brand)] transition-opacity hover:opacity-100 focus:opacity-100 ${isSelected ? 'opacity-100' : 'opacity-0'}`}
                        onPointerDown={(event) => {
                          event.stopPropagation()
                          setConnectingFrom(node.id)
                        }}
                      >
                        <ArrowRight className="size-2.5 rotate-90" />
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>

          {nodes.length === 0 && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center p-8 text-center">
              <div className="max-w-[300px] rounded-md border border-dashed border-[var(--launcher-border)] bg-[var(--launcher-surface)]/90 px-6 py-8 text-sm text-[var(--launcher-muted)]">
                <Persons className="mx-auto mb-3 size-7 text-[var(--launcher-brand)]" />
                {t('launcher.collaboration.canvas_empty')}
              </div>
            </div>
          )}

          <span className="pointer-events-none absolute bottom-3 left-3 z-10 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)]/90 px-2.5 py-1.5 text-[11px] text-[var(--launcher-muted)]">
            {t('launcher.collaboration.canvas_pan_hint')}
          </span>
          {edgeHover.left && (
            <button
              type="button"
              title={t('launcher.collaboration.canvas_expand_left')}
              className="absolute left-2 top-1/2 z-10 grid size-8 -translate-y-1/2 place-items-center rounded-full border border-[var(--launcher-brand)] bg-[var(--launcher-surface)] text-[var(--launcher-brand)] shadow-[0_4px_12px_rgba(42,70,90,0.18)] hover:bg-white"
              onClick={() => expandWorld('left')}
            >
              <Plus className="size-4" />
            </button>
          )}
          {edgeHover.top && (
            <button
              type="button"
              title={t('launcher.collaboration.canvas_expand_top')}
              className="absolute left-1/2 top-2 z-10 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-[var(--launcher-brand)] bg-[var(--launcher-surface)] text-[var(--launcher-brand)] shadow-[0_4px_12px_rgba(42,70,90,0.18)] hover:bg-white"
              onClick={() => expandWorld('top')}
            >
              <Plus className="size-4" />
            </button>
          )}
          {edgeHover.right && (
            <button
              type="button"
              title={t('launcher.collaboration.canvas_expand_right')}
              className="absolute right-2 top-1/2 z-10 grid size-8 -translate-y-1/2 place-items-center rounded-full border border-[var(--launcher-brand)] bg-[var(--launcher-surface)] text-[var(--launcher-brand)] shadow-[0_4px_12px_rgba(42,70,90,0.18)] hover:bg-white"
              onClick={() => expandWorld('right')}
            >
              <Plus className="size-4" />
            </button>
          )}
          {edgeHover.bottom && (
            <button
              type="button"
              title={t('launcher.collaboration.canvas_expand_bottom')}
              className="absolute bottom-2 left-1/2 z-10 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-[var(--launcher-brand)] bg-[var(--launcher-surface)] text-[var(--launcher-brand)] shadow-[0_4px_12px_rgba(42,70,90,0.18)] hover:bg-white"
              onClick={() => expandWorld('bottom')}
            >
              <Plus className="size-4" />
            </button>
          )}
        </div>
        <div className={`min-w-0 flex-1 overflow-y-auto p-5 ${collabView === 'workflows' ? '' : 'hidden'}`}>
          <div className="mx-auto max-w-[760px]">
            <h2 className="m-0 text-lg font-semibold">{t('launcher.collaboration.workflows_title')}</h2>
            <p className="mt-1 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.collaboration.workflows_description')}</p>
            <div className="mt-6">
              <h3 className="m-0 text-sm font-semibold">{t('launcher.collaboration.workflows_templates_title')}</h3>
              <p className="mt-1 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.collaboration.workflows_templates_hint')}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {WORKFLOW_TEMPLATES.map(template => (
                  <div key={template.id} className="rounded-md border border-[var(--launcher-border)] bg-white/70 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{t(template.nameKey)}</div>
                        <div className="mt-1 text-xs leading-4 text-[var(--launcher-muted)]">{t(template.descKey)}</div>
                        <div className="mt-1 text-[11px] text-[var(--launcher-muted)]">{t('launcher.collaboration.workflow_nodes', { count: template.nodes.length })}</div>
                      </div>
                      <button
                        type="button"
                        disabled={workflowActionBusy}
                        className="flex-none rounded-md border border-[var(--launcher-border)] bg-white/80 px-2.5 py-1.5 text-xs hover:border-[var(--launcher-brand)] disabled:opacity-50"
                        onClick={() => openTemplate(template)}
                      >
                        {t('launcher.collaboration.workflow_open')}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
            {workflows.length === 0
              ? (
                  <div className="mt-6 rounded-md border border-dashed border-[var(--launcher-border)] bg-white/50 px-6 py-10 text-center text-sm text-[var(--launcher-muted)]">
                    {t('launcher.collaboration.workflows_empty')}
                  </div>
                )
              : (
                  <ul className="mt-4 space-y-2">
                    {workflows.map(workflow => (
                      <li key={workflow.id} className="rounded-md border border-[var(--launcher-border)] bg-white/70 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium">{workflow.name}</div>
                            <div className="mt-1 truncate text-[11px] text-[var(--launcher-muted)]">
                              {workflow.workspace || t('launcher.collaboration.workflow_workspace_empty')}
                            </div>
                            <div className="mt-1 text-[11px] text-[var(--launcher-muted)]">
                              {t('launcher.collaboration.workflow_nodes', { count: workflow.nodeCount })}
                              {' · '}
                              {new Date(workflow.updatedAt).toLocaleString()}
                            </div>
                          </div>
                          <div className="flex flex-none items-center gap-1.5">
                            <button
                              type="button"
                              disabled={workflowActionBusy}
                              className="rounded-md border border-[var(--launcher-border)] bg-white/80 px-2.5 py-1.5 text-xs hover:border-[var(--launcher-brand)] disabled:opacity-50"
                              onClick={() => { void openWorkflow(workflow.id, false) }}
                            >
                              {t('launcher.collaboration.workflow_open')}
                            </button>
                            <button
                              type="button"
                              disabled={workflowActionBusy}
                              className="rounded-md bg-[var(--launcher-brand)] px-2.5 py-1.5 text-xs text-white hover:bg-[var(--launcher-brand-strong)] disabled:opacity-50"
                              onClick={() => { void openWorkflow(workflow.id, true) }}
                            >
                              {t('launcher.collaboration.workflow_enable')}
                            </button>
                            <button
                              type="button"
                              disabled={workflowActionBusy}
                              title={t('launcher.collaboration.workflow_delete')}
                              className={`rounded-md border px-2.5 py-1.5 text-xs ${confirmDeleteWorkflowId === workflow.id ? 'border-danger/50 bg-danger/10 text-danger' : 'border-[var(--launcher-border)] bg-white/80 text-[var(--launcher-ink)] hover:border-danger/40 hover:text-danger'} disabled:opacity-50`}
                              onClick={() => { void deleteWorkflow(workflow.id) }}
                            >
                              {confirmDeleteWorkflowId === workflow.id ? t('launcher.collaboration.workflow_delete_confirm') : t('launcher.collaboration.workflow_delete')}
                            </button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
          </div>
        </div>

        {collabView === 'creator' && (
          <aside className="hidden w-[240px] flex-none overflow-y-auto border-l border-[var(--launcher-border)] bg-[var(--launcher-sidebar)] p-3 lg:block">
            <div className="px-3 pb-3 pt-2 text-xs font-semibold text-[var(--launcher-muted)]">{t('launcher.collaboration.inspector_title')}</div>
            {selectedNode
              ? (
                  <div className="mt-5">
                    <h2 className="m-0 truncate text-base font-semibold">{selectedInstance?.name ?? t('launcher.collaboration.node_unassigned_instance')}</h2>
                    {selectedInstance && (
                      <div className="mt-1 text-xs text-[var(--launcher-muted)]">
                        {t('launcher.collaboration.profile')}
                        {' '}
                        {selectedInstance.profile}
                      </div>
                    )}
                    <div className="mt-3 flex items-center gap-2 text-xs">
                      <span className="size-2 rounded-full" style={{ backgroundColor: STATUS_DOT[selectedStatus] }} />
                      <span className={selectedStatus === 'failed' ? 'text-danger' : selectedStatus === 'done' ? 'text-[#2d7a5c]' : selectedStatus === 'running' ? 'text-[#9a6f16]' : 'text-[var(--launcher-muted)]'}>
                        {t(`launcher.collaboration.node_status_${selectedStatus}`)}
                      </span>
                    </div>
                    {selectedStatus === 'running' && (
                      <p className="mt-2 text-[11px] leading-4 text-[var(--launcher-muted)]">{t('launcher.collaboration.node_auto_monitored')}</p>
                    )}
                    {selectedInstance && runningIds.has(selectedInstance.id)
                      ? (
                          <button
                            type="button"
                            className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--launcher-border)] bg-white/70 px-3 py-2 text-xs hover:bg-white"
                            onClick={() => { void openInstanceWindow(selectedInstance.id) }}
                          >
                            <ArrowUpRightFromSquare className="size-3.5" />
                            {t('launcher.collaboration.open_instance')}
                          </button>
                        )
                      : (
                          selectedInstance
                            ? <p className="mt-3 text-[11px] leading-4 text-[var(--launcher-muted)]">{t('launcher.collaboration.instance_not_running')}</p>
                            : (
                                <div className="mt-3 space-y-1.5">
                                  <div className="text-[11px] text-[var(--launcher-muted)]">{t('launcher.collaboration.assign_instance_label')}</div>
                                  <SelectField
                                    value=""
                                    className="w-full"
                                    onChange={(event) => {
                                      if (event.target.value)
                                        assignNodeInstance(event.target.value)
                                    }}
                                  >
                                    <option value="" disabled>{t('launcher.collaboration.assign_instance_placeholder')}</option>
                                    {registry.instances
                                      .filter(instance => !nodes.some(node => node.id !== selectedNode.id && node.instanceId === instance.id))
                                      .map(instance => <option key={instance.id} value={instance.id}>{instance.name}</option>)}
                                  </SelectField>
                                </div>
                              )
                        )}
                    <div className="mt-5 space-y-3 text-xs">
                      <div>
                        <div className="text-[var(--launcher-muted)]">{t('launcher.collaboration.task_label')}</div>
                        <textarea
                          rows={3}
                          value={selectedNode.task}
                          onChange={event => updateNodeField(selectedNode.id, 'task', event.target.value)}
                          placeholder={t('launcher.collaboration.task_placeholder')}
                          className="mt-1 w-full resize-y rounded-md border border-[var(--launcher-border)] bg-white/70 px-2.5 py-2 text-xs leading-4 outline-none focus:border-[var(--launcher-brand)]"
                        />
                      </div>

                      <div className="rounded-md border border-[var(--launcher-border)] bg-white/60 px-3 py-2">
                        <div className="text-[var(--launcher-muted)]">{t('launcher.collaboration.upstream_title')}</div>
                        {selectedParentNodes.length === 0
                          ? <div className="mt-2 text-[11px] text-[var(--launcher-muted)]">{t('launcher.collaboration.upstream_empty')}</div>
                          : (
                              <ul className="mt-2 space-y-2">
                                {selectedParentNodes.map((parentNode) => {
                                  const parentInstance = instanceById.get(parentNode.instanceId)
                                  const parentStatus = nodeStatus[parentNode.id] ?? 'idle'
                                  return (
                                    <li key={parentNode.id} className="min-w-0">
                                      <div className="flex min-w-0 items-center gap-1.5">
                                        <span className="size-1.5 flex-none rounded-full" style={{ backgroundColor: STATUS_DOT[parentStatus] }} />
                                        <span className="truncate font-medium">{parentInstance?.name ?? (parentNode.instanceId ? t('launcher.collaboration.unknown_instance') : t('launcher.collaboration.node_unassigned_instance'))}</span>
                                      </div>
                                      <div className="mt-1 whitespace-pre-wrap break-words rounded bg-white/60 px-2 py-1.5 text-[11px] leading-4 text-[var(--launcher-muted)]">
                                        {parentNode.result.trim() || (parentStatus === 'done' ? t('launcher.collaboration.upstream_empty_result') : t('launcher.collaboration.upstream_pending'))}
                                      </div>
                                    </li>
                                  )
                                })}
                              </ul>
                            )}
                      </div>

                      <div>
                        <div className="text-[var(--launcher-muted)]">{t('launcher.collaboration.result_label')}</div>
                        <textarea
                          rows={2}
                          value={selectedNode.result}
                          onChange={event => updateNodeField(selectedNode.id, 'result', event.target.value)}
                          placeholder={t('launcher.collaboration.result_placeholder')}
                          className="mt-1 w-full resize-y rounded-md border border-[var(--launcher-border)] bg-white/70 px-2.5 py-2 text-xs leading-4 outline-none focus:border-[var(--launcher-brand)]"
                        />
                      </div>

                      {selectedStatus === 'running' && (
                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="flex-1 rounded-md bg-[var(--launcher-brand)] px-3 py-2 text-white transition-colors hover:bg-[var(--launcher-brand-strong)]"
                            onClick={() => completeNode(selectedNode.id)}
                          >
                            {t('launcher.collaboration.complete_node')}
                          </button>
                          <button
                            type="button"
                            className="flex-1 rounded-md border border-danger/40 px-3 py-2 text-danger transition-colors hover:bg-danger/5"
                            onClick={() => failNode(selectedNode.id)}
                          >
                            {t('launcher.collaboration.fail_node')}
                          </button>
                        </div>
                      )}

                      {selectedChildren.length > 0
                        ? (
                            <div className="rounded-md border border-[var(--launcher-border)] bg-white/60 px-3 py-2">
                              <div className="text-[var(--launcher-muted)]">{t('launcher.collaboration.mode_title')}</div>
                              <div className="mt-2 flex gap-1">
                                {(['serial', 'parallel'] as CollaborationMode[]).map(item => (
                                  <button
                                    key={item}
                                    type="button"
                                    aria-pressed={selectedNode?.childrenMode === item}
                                    className={`flex-1 rounded px-2 py-1.5 ${selectedNode?.childrenMode === item ? 'bg-[var(--launcher-selected)] font-medium text-[var(--launcher-brand-strong)]' : 'text-[var(--launcher-muted)] hover:bg-white'}`}
                                    onClick={() => {
                                      commitGraph(
                                        graphRef.current.nodes.map(node => node.id === selectedNode.id ? { ...node, childrenMode: item } : node),
                                        graphRef.current.edges,
                                      )
                                    }}
                                  >
                                    {t(`launcher.collaboration.mode_${item}`)}
                                  </button>
                                ))}
                              </div>
                              <p className="mt-2 text-[11px] leading-4 text-[var(--launcher-muted)]">{t('launcher.collaboration.mode_hint')}</p>
                            </div>
                          )
                        : (
                            <div className="rounded-md border border-dashed border-[var(--launcher-border)] bg-white/50 px-3 py-2 text-[var(--launcher-muted)]">{t('launcher.collaboration.mode_no_children')}</div>
                          )}
                      <div className={`flex items-start gap-2 rounded-md border px-3 py-2 ${hasParallelHomeConflict ? 'border-[#e4b1b1] bg-[#fff3f3] text-danger' : 'border-[var(--launcher-border)] bg-white/60 text-[var(--launcher-muted)]'}`}>
                        {hasParallelHomeConflict ? <CircleXmark className="mt-0.5 size-3.5 flex-none" /> : <CircleCheck className="mt-0.5 size-3.5 flex-none" />}
                        <span>{hasParallelHomeConflict ? t('launcher.collaboration.parallel_conflict') : t('launcher.collaboration.node_ready')}</span>
                      </div>
                      <button
                        type="button"
                        disabled={runState === 'running'}
                        title={runState === 'running' ? t('launcher.collaboration.remove_blocked') : undefined}
                        className="mt-6 flex w-full items-center justify-center gap-2 rounded-md border border-[#e4b1b1] px-3 py-2 text-xs text-danger hover:bg-[#fff3f3] disabled:cursor-not-allowed disabled:opacity-50"
                        onClick={removeSelectedNode}
                      >
                        <TrashBin className="size-3.5" />
                        {t('launcher.collaboration.remove_node')}
                      </button>
                    </div>
                  </div>
                )
              : <div className="mt-5 text-xs leading-5 text-[var(--launcher-muted)]">{t('launcher.collaboration.inspector_empty')}</div>}
          </aside>
        )}
      </div>
    </main>
  )
}
