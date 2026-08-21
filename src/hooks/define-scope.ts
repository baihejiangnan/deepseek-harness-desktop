import { createContext, createElement } from 'react'

export interface Scope<T> {
  Provider: React.FC<{
    children: React.ReactNode | ((value: T) => React.ReactNode)
  }>
  Context: React.Context<T | undefined>
}

export function defineScope<T>(useSetup: () => T): Scope<T> {
  const Context = createContext<T | undefined>(undefined)

  function Provider({ children }: any) {
    const value = useSetup()
    const child = typeof children === 'function' ? children(value) : children
    return createElement(Context.Provider, { value }, child)
  }

  return { Provider, Context }
}
