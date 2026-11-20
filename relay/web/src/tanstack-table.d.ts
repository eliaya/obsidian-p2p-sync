import '@tanstack/react-table'

declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- type parameters must match the declaration being augmented
  interface ColumnMeta<TData, TValue> {
    className?: string // apply to both th and td
    label?: string // column name in the view options menu
    tdClassName?: string
    thClassName?: string
  }
}
