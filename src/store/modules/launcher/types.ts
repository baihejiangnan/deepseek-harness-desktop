export interface DshVersionRef {
  channel: string
  tag: string
}

export interface DshInstance {
  id: string
  name: string
  dshHome: string
  profile: string
  version: DshVersionRef
  favorite: boolean
  createdAt: number
}

export interface InstanceRegistry {
  instances: DshInstance[]
  activeInstanceId: string | null
}

export interface InstanceSharing {
  homeUsers: number
  profileUsers: number
  level: 'isolated' | 'shared_home' | 'shared_profile'
}

export interface InstanceRemovalImpact {
  dshHome: string
  instances: DshInstance[]
  profiles: string[]
}

export type LauncherView = 'launcher' | 'dsh'
