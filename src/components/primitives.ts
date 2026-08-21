import { tv } from 'tailwind-variants'

// ==================== 按钮 ====================
// 仅保留给 loadable / setup 加载页使用的按钮样式（其余组件已全部改用 HeroUI）。
// 对应官方 ui-primitives Button 的两档几何：
// md（h36 / 圆角 18px 胶囊 / 14px 字号）与 sm（h28 / 圆角 14px 胶囊 / 12px 字号）。
// 颜色沿用官方 dsw alias token（bg-btn-fill / interactive-bg-* 等）。
export const button = tv({
  base: 'inline-flex cursor-pointer items-center justify-center gap-1 transition-colors disabled:cursor-not-allowed disabled:opacity-40',
  variants: {
    size: {
      sm: 'h-7 rounded-[14px] px-2.5 text-xs',
      md: 'h-9 rounded-[18px] px-3.5 text-sm leading-[22px]',
    },
    tone: {
      primary: 'bg-btn-fill text-btn-ink hover:bg-btn-fill-hover',
      ghost: 'text-ink hover:bg-btn-hover active:bg-btn-active',
      danger: 'text-danger hover:bg-btn-danger-hover',
    },
    block: {
      true: 'mt-1.5 w-full',
    },
  },
  defaultVariants: {
    size: 'md',
    tone: 'ghost',
  },
})
