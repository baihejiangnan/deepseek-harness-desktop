import type { ReactNode } from 'react'
import type { PlanResponse } from './provider-contracts'
import { useTranslation } from 'react-i18next'
import { StatusBadge, StatusNotice } from './launcher-ui'

/**
 * 值只可能来自模板自有字段（不含凭据与请求头），因此可以安全渲染。
 * 模型清单只包含允许回传的自有字段，并展开关键参数供用户核对。
 */
function describe(value: unknown): string {
  if (value === null || value === undefined)
    return '—'
  if (typeof value === 'string')
    return value === '' ? '—' : value
  if (Array.isArray(value)) {
    return value.length > 0 ? value.map(describe).join('\n') : '—'
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    return entries.length > 0 ? entries.map(([key, entry]) => `${key}: ${describe(entry)}`).join(' · ') : '—'
  }
  return String(value)
}

/**
 * 变更预览。模板导入、实例内添加、实例内编辑与移除共用这一份渲染：
 * 同一种计划不该在不同入口显示出不同的详细程度。
 * `children` 用于把"应用/取消"这类入口特定的操作挂在预览下方。
 */
export default function ProviderPlanView({ preview, children }: { preview: PlanResponse, children?: ReactNode }) {
  const { t } = useTranslation()
  const { plan } = preview
  return (
    <div className="min-w-0 space-y-3">
      <div className="max-h-[42vh] space-y-3 overflow-y-auto pr-1">
        <p role="status" className="m-0 text-xs text-[var(--launcher-muted)]">{t('providers.preview_summary', { count: plan.changes.length })}</p>
        {plan.sharing.level !== 'isolated' && (
          <StatusNotice tone="neutral" message={t('providers.preview_sharing', { homes: plan.sharing.homeUsers, profiles: plan.sharing.profileUsers })} />
        )}
        {plan.warnings.map(warning => (
          <StatusNotice key={warning.code + warning.detail} tone="neutral" message={t('providers.preview_warning_default', { detail: warning.detail })} />
        ))}
        {plan.defaultModelAction !== 'keep' && (
          <p role="status" className="m-0 text-xs text-[var(--launcher-ink)]">
            {plan.defaultModelAction === 'clear'
              ? t('providers.preview_default_model_clear')
              : t('providers.preview_default_model_set', { detail: `${plan.defaultModel?.provider ?? ''}/${plan.defaultModel?.model ?? ''}` })}
          </p>
        )}
        <ul className="m-0 list-none space-y-2 p-0">
          {plan.changes.map(change => (
            <li key={change.routeId} className="rounded-md border border-[var(--launcher-border)] px-3 py-2">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 break-all font-medium">{change.routeId}</span>
                <StatusBadge tone={change.kind === 'add' ? 'success' : change.kind === 'modify' ? 'accent' : change.kind === 'remove' ? 'danger' : 'neutral'}>
                  {t(`providers.change.${change.kind}`)}
                </StatusBadge>
                {change.credential && (
                  <StatusBadge tone={change.credential.action === 'remove' ? 'danger' : 'neutral'}>
                    {t(`providers.credential_action.${change.credential.action}`)}
                  </StatusBadge>
                )}
              </div>
              {change.fields.length > 0 && (
                <ul className="m-0 mt-1 list-none space-y-0.5 p-0 text-xs">
                  {change.fields.map(field => (
                    <li key={field.field} className="min-w-0 break-all">
                      <span className="font-medium">{t(`providers.field.${field.field}`, { defaultValue: field.field })}</span>
                      <div className="mt-2 grid gap-3 sm:grid-cols-2">
                        <div className="min-w-0">
                          <p className="mb-1 text-[var(--launcher-muted)]">{t('providers.preview_before')}</p>
                          <div className="whitespace-pre-wrap break-words leading-5">{describe(field.from)}</div>
                        </div>
                        <div className="min-w-0">
                          <p className="mb-1 text-[var(--launcher-muted)]">{t('providers.preview_after')}</p>
                          <div className="whitespace-pre-wrap break-words leading-5">{describe(field.to)}</div>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {change.preservedFields.length > 0 && (
                <p className="m-0 mt-1 text-xs text-[var(--launcher-muted)]">
                  {t(change.kind === 'remove' ? 'providers.preview_removed_foreign' : 'providers.preview_preserved', { fields: change.preservedFields.join(', ') })}
                </p>
              )}
            </li>
          ))}
        </ul>
        {plan.retainedCredentialRefs.length > 0 && (
          <p className="m-0 min-w-0 break-words text-xs leading-5 text-[var(--launcher-muted)]">
            {t('providers.preview_retained_refs', { count: plan.retainedCredentialRefs.length, refs: plan.retainedCredentialRefs.join(', ') })}
          </p>
        )}
      </div>
      {children && <div className="border-t border-[var(--launcher-border)] pt-3">{children}</div>}
    </div>
  )
}
