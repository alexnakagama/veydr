import { channels, getInfoRequestSchema, type AppInfo } from '../../shared/api'
import type { IpcRegistry } from './register'

export function registerAppHandlers(registry: IpcRegistry, getInfo: () => AppInfo): void {
  registry.handle(channels.app.getInfo, getInfoRequestSchema, () => getInfo())
}
