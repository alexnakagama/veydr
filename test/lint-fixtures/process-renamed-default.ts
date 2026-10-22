import proc from 'node:process'

export const isLinux = proc.platform === 'linux'
