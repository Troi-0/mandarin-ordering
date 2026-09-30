import { menuSchema, type Menu } from './menu-schema.ts'

// Called only in Vite development mode. The unused module and eager JSON imports
// are removed from production builds along with App's DEV branch.
export function loadDevelopmentMenu(
  current: Menu | null,
  archives: Record<string, unknown> = import.meta.glob('../../data/menus/*.json', { eager: true, import: 'default' }),
): Menu | null {
  let latest = current
  for (const raw of Object.values(archives)) {
    const result = menuSchema.safeParse(raw)
    if (result.success && (!latest || result.data.date > latest.date)) latest = result.data
  }
  // On equal dates, the current publication wins so corrections are retained.
  return latest
}
