// 启动器共享界面基元（方案 §3.2）。
//
// 这些类名全部从 `download-center` / `instance-settings` / `provider-templates`
// 里既有的手写标记原样提取，目的是让 adopting 不产生视觉跳变。约束：
// - 组件不内置任何用户可见文案，文本一律由调用方传入已翻译字符串，避免把
//   `download.*` 之类的页面命名空间 key 固化进共享层。
// - 字号不低于 `text-xs`(12px)，不使用 `text-[10px]`。
// - 不改动 `main.css` 的 `body{font-size}` 全站基准。

import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight } from '@gravity-ui/icons'
import { Button } from '@heroui/react'

const cardClass = 'launcher-panel rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)]'
const mutedClass = 'text-[var(--launcher-muted)]'
const fieldClass = 'h-10 w-full min-w-0 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] px-3 text-sm text-[var(--launcher-ink)] outline-none transition-colors focus:border-[var(--launcher-brand)] focus-visible:ring-2 focus-visible:ring-[var(--launcher-selected)] disabled:opacity-60 motion-reduce:transition-none'

/** 紧凑页头：标题 + 可选说明 + 右侧操作。不再渲染与标题重复的小标签。 */
export function PageHeader(props: { title: string, description?: string, status?: ReactNode, actions?: ReactNode, className?: string }) {
  return (
    <header className={`flex flex-wrap items-end justify-between gap-x-6 gap-y-3 ${props.className ?? 'mb-6'}`}>
      <div className="min-w-0 flex-1">
        <h1 className="m-0 text-[22px] font-semibold tracking-[-0.015em]">{props.title}</h1>
        {props.description && <p className={`m-0 mt-1.5 max-w-[72ch] text-sm leading-6 ${mutedClass}`}>{props.description}</p>}
      </div>
      {(props.status || props.actions) && (
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
          {props.status}
          {props.actions}
        </div>
      )}
    </header>
  )
}

/** 分区卡片。标题层级为 h2，描述与操作各占其位。 */
export function SectionCard(props: { title?: string, description?: string, actions?: ReactNode, children: ReactNode, className?: string, padded?: boolean }) {
  const padded = props.padded ?? true
  return (
    <section className={`${cardClass} ${padded ? 'p-5 lg:p-6' : ''} ${props.className ?? ''}`}>
      {(props.title || props.actions) && (
        <div className="mb-4 flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            {props.title && <h2 className="m-0 text-base font-semibold">{props.title}</h2>}
            {props.description && <p className={`m-0 mt-1 text-xs leading-5 ${mutedClass}`}>{props.description}</p>}
          </div>
          {props.actions && <div className="flex flex-none items-center gap-2">{props.actions}</div>}
        </div>
      )}
      {props.children}
    </section>
  )
}

/** 列表/目录页的工具区：搜索、筛选与主操作集中在一行，窄窗口自动换行。 */
export function Toolbar(props: { children: ReactNode, className?: string }) {
  return (
    <div className={`flex flex-wrap items-end gap-3 ${props.className ?? ''}`}>
      {props.children}
    </div>
  )
}

/** 带标签的搜索框，语义为 type=search。 */
export function SearchInput(props: { label: string, value: string, onChange: (value: string) => void, placeholder?: string, disabled?: boolean, className?: string }) {
  return (
    <label className={`min-w-0 flex-1 text-xs ${mutedClass} ${props.className ?? ''}`}>
      {props.label}
      <input
        type="search"
        aria-label={props.label}
        placeholder={props.placeholder ?? props.label}
        className={`mt-1 ${fieldClass}`}
        disabled={props.disabled}
        value={props.value}
        onChange={event => props.onChange(event.target.value)}
      />
    </label>
  )
}

/** 空状态：虚线框，文案由调用方按"无数据"还是"无匹配结果"选择。 */
export function EmptyState(props: { text: string, action?: ReactNode, className?: string }) {
  return (
    <div className={`rounded-md border border-dashed border-[var(--launcher-border)] p-8 text-center ${props.className ?? ''}`}>
      <p className="m-0 text-sm break-words">
        {props.text}
      </p>
      {props.action && <div className="mt-3 flex justify-center">{props.action}</div>}
    </div>
  )
}

/** 持久失败：留在页面上，不靠 Toast 一闪而过。detail 用于展示原始错误码或原因。 */
export function ErrorBanner(props: { message: string, detail?: string, action?: ReactNode, className?: string }) {
  return (
    <div role="alert" className={`rounded-md border border-danger/25 bg-danger/5 p-3 ${props.className ?? ''}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="m-0 min-w-0 flex-1 text-sm break-words text-danger">{props.message}</p>
        {props.action && <div className="flex flex-none items-center">{props.action}</div>}
      </div>
      {props.detail && <p className={`m-0 mt-1.5 text-xs leading-5 break-all font-mono ${mutedClass}`}>{props.detail}</p>}
    </div>
  )
}

/** 进行中/结果性说明，与失败区分开。 */
export function StatusNotice(props: { message: string, tone?: 'neutral' | 'accent', className?: string }) {
  const tone = props.tone ?? 'accent'
  return (
    <p role="status" className={`m-0 rounded-md px-3 py-2 text-sm ${tone === 'accent' ? `bg-[var(--launcher-selected)] text-[var(--launcher-brand-strong)]` : `${cardClass} ${mutedClass}`} ${props.className ?? ''}`}>
      {props.message}
    </p>
  )
}

/**
 * 状态徽章。文字始终存在——状态不得只靠颜色表达（方案 §3.8）。
 * tone 只负责着色，承载语义的是 children。
 */
export function StatusBadge(props: { children: ReactNode, tone?: 'neutral' | 'accent' | 'success' | 'danger', className?: string }) {
  const tone = props.tone ?? 'neutral'
  // 仓库色板只定义了 danger 与 ok；需要第三种语气由调用方传 className，不在此发明色值。
  const tones = {
    neutral: `border-[var(--launcher-border)] bg-[var(--launcher-surface)] ${mutedClass}`,
    accent: 'border-[var(--launcher-brand)]/25 bg-[var(--launcher-selected)] text-[var(--launcher-brand-strong)]',
    success: 'border-ok/25 bg-ok/10 text-ok',
    danger: 'border-danger/25 bg-danger/5 text-danger',
  }
  return (
    <span className={`inline-block rounded border px-2 py-0.5 text-xs leading-5 ${tones[tone]} ${props.className ?? ''}`}>
      {props.children}
    </span>
  )
}

/**
 * 带标签的表单字段，错误与提示就近渲染（方案 §2.5、§3.2）。
 * 控件默认限制在阅读宽度内，避免简单输入框横跨整个内容列；
 * 需要占满时由调用方传 controlClassName。
 */
export function Field(props: { label: string, hint?: string, error?: string, required?: boolean, disabled?: boolean, children: ReactNode, controlClassName?: string, labelFor?: string }) {
  const describedBy = props.error ? `${props.labelFor}-error` : props.hint ? `${props.labelFor}-hint` : undefined
  return (
    <div className="min-w-0">
      <label htmlFor={props.labelFor} className="mb-1.5 block text-xs font-medium">
        {props.label}
        {props.required && (
          <span className="text-danger">
            {' '}
            *
          </span>
        )}
      </label>
      <div className={`max-w-[420px] ${props.controlClassName ?? ''}`}>
        {props.children}
      </div>
      {props.error
        ? <p id={describedBy} className="m-0 mt-1.5 text-xs leading-5 break-words text-danger">{props.error}</p>
        : props.hint && <p id={describedBy} className={`m-0 mt-1.5 text-xs leading-5 break-words ${mutedClass}`}>{props.hint}</p>}
    </div>
  )
}

/** 文本输入，供 Field 包裹使用。`onChange` 可省：只读展示值（如不可变的路由 ID）没有变更语义。 */
export function TextInput(props: { value: string, onChange?: (value: string) => void, id?: string, type?: 'text' | 'password' | 'search', placeholder?: string, disabled?: boolean, invalid?: boolean, autoComplete?: string, mono?: boolean }) {
  return (
    <input
      id={props.id}
      type={props.type ?? 'text'}
      value={props.value}
      placeholder={props.placeholder}
      disabled={props.disabled}
      autoComplete={props.autoComplete}
      aria-invalid={props.invalid || undefined}
      className={`${fieldClass} ${props.mono ? 'font-mono text-xs' : ''}`}
      onChange={event => props.onChange?.(event.target.value)}
    />
  )
}

/** 长表单的固定底部操作区，滚动时保持可达（从 provider-templates 既有实现推广）。 */
export function ActionBar(props: { children: ReactNode, notice?: ReactNode, className?: string }) {
  return (
    <div className={`sticky bottom-0 z-10 -mx-6 -mb-6 mt-6 flex flex-wrap items-center justify-end gap-3 border-t border-[var(--launcher-border)] bg-[var(--launcher-surface)]/95 px-6 py-3 backdrop-blur-sm ${props.className ?? ''}`}>
      {props.notice && <div className="mr-auto min-w-0 text-xs">{props.notice}</div>}
      {props.children}
    </div>
  )
}

/**
 * 进度。有真实分项数据才传 total>0；无法测量时传 total=0 走不确定态，
 * 不伪造百分比（方案 §3.5）。
 */
export function ProgressBar(props: { completed: number, total: number, label: string, className?: string }) {
  const measurable = props.total > 0
  const percent = measurable ? Math.min(100, Math.round((props.completed / props.total) * 100)) : 0
  return (
    <div className={props.className ?? ''}>
      <div className={`flex items-center justify-between gap-3 text-xs ${mutedClass}`}>
        <span className="min-w-0 truncate">{props.label}</span>
        {measurable && (
          <span className="flex-none tabular-nums">
            {props.completed}
            /
            {props.total}
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label={props.label}
        aria-valuenow={measurable ? props.completed : undefined}
        aria-valuemin={measurable ? 0 : undefined}
        aria-valuemax={measurable ? props.total : undefined}
        className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[var(--launcher-selected)]"
      >
        {measurable
          ? <div className="h-full rounded-full bg-[var(--launcher-brand)] transition-[width] motion-reduce:transition-none" style={{ width: `${percent}%` }} />
          : <div className="h-full w-2/5 animate-pulse rounded-full bg-[var(--launcher-brand)] motion-reduce:animate-none" aria-hidden="true" />}
      </div>
    </div>
  )
}

/** 分页条。文案全部由调用方传入，避免固化页面命名空间的 key。 */
export function PaginationBar(props: { page: number, totalPages: number, onChange: (page: number) => void, statusText: string, previousLabel: string, nextLabel: string }) {
  return (
    <div className="sticky bottom-0 z-10 flex items-center justify-between gap-3 border-t border-[var(--launcher-border)] bg-[var(--launcher-surface)]/95 px-4 py-2.5 backdrop-blur-sm">
      <span className={`min-w-0 truncate text-xs ${mutedClass}`}>{props.statusText}</span>
      <div className="flex flex-none items-center gap-1">
        <Button isIconOnly size="sm" variant="ghost" className="size-8 min-w-8 rounded-md" aria-label={props.previousLabel} isDisabled={props.page <= 1} onPress={() => props.onChange(props.page - 1)}>
          <ArrowLeft className="size-4" />
        </Button>
        <Button isIconOnly size="sm" variant="ghost" className="size-8 min-w-8 rounded-md" aria-label={props.nextLabel} isDisabled={props.page >= props.totalPages} onPress={() => props.onChange(props.page + 1)}>
          <ArrowRight className="size-4" />
        </Button>
      </div>
    </div>
  )
}
