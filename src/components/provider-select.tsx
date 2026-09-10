import type { CSSProperties } from 'react'
import { ListBox, Select } from '@heroui/react'
import { useRef, useState } from 'react'

/** Provider controls share the launcher's themed, keyboard-accessible popup. */
export default function ProviderSelect({ label, value, options, onChange, disabled = false, placeholder }: {
  label: string
  value: string
  options: { value: string, label: string, disabled?: boolean }[]
  onChange: (value: string) => void
  disabled?: boolean
  placeholder?: string
}) {
  const anchorRef = useRef<HTMLDivElement>(null)
  const [palette, setPalette] = useState<CSSProperties>({})
  return (
    <div ref={anchorRef} className="min-w-0 w-full">
      <Select
        aria-label={label}
        selectedKey={value || null}
        placeholder={placeholder}
        isDisabled={disabled}
        onOpenChange={(open) => {
          if (open && anchorRef.current) {
            const computed = getComputedStyle(anchorRef.current)
            setPalette(Object.fromEntries(['surface', 'ink', 'border', 'selected', 'brand', 'muted'].map(token => [`--launcher-${token}`, computed.getPropertyValue(`--launcher-${token}`)])))
          }
        }}
        onSelectionChange={key => onChange(String(key ?? ''))}
        className="launcher-select min-w-0 w-full"
      >
        <Select.Trigger className="h-10 rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] text-[var(--launcher-ink)]">
          <Select.Value />
          <Select.Indicator />
        </Select.Trigger>
        <Select.Popover style={palette} className="launcher-select-popover max-h-64 overflow-y-auto rounded-md border border-[var(--launcher-border)] bg-[var(--launcher-surface)] text-[var(--launcher-ink)]">
          <ListBox disabledKeys={options.filter(option => option.disabled).map(option => option.value)}>
            {options.map(option => <ListBox.Item className="rounded-md text-[var(--launcher-ink)] data-[hovered=true]:bg-[var(--launcher-selected)] data-[selected=true]:bg-[var(--launcher-selected)]" key={option.value} id={option.value} textValue={option.label}>{option.label}</ListBox.Item>)}
          </ListBox>
        </Select.Popover>
      </Select>
    </div>
  )
}
