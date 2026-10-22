import { platform } from 'node:os'

export const isLinux = platform() === 'linux'
