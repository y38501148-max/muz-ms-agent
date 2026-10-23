<script setup lang="ts">
import type { Component } from 'vue'
import {
  AppstoreOutlined, ApiOutlined, CodeOutlined, CloudServerOutlined,
  BulbOutlined, RobotOutlined, GlobalOutlined, DatabaseOutlined,
  DeploymentUnitOutlined, LaptopOutlined, ClusterOutlined, NodeIndexOutlined,
  FileTextOutlined, TeamOutlined,
} from '@ant-design/icons-vue'

const props = defineProps<{ name: string }>()
const icons: Record<string, Component> = {
  backend: ApiOutlined, api: ApiOutlined, frontend: LaptopOutlined, fullstack: RobotOutlined,
  platform: CloudServerOutlined, cpp: CodeOutlined, ai: BulbOutlined,
  code: CodeOutlined, cloud: CloudServerOutlined, robot: RobotOutlined,
  os: ClusterOutlined, network: GlobalOutlined, database: DatabaseOutlined,
  'system-design': DeploymentUnitOutlined, devops: CloudServerOutlined,
  algorithms: NodeIndexOutlined, languages: CodeOutlined, 'ai-agent': RobotOutlined,
  projects: FileTextOutlined, behavior: TeamOutlined,
}
const icon = computed(() => icons[props.name] || AppstoreOutlined)
</script>

<template><component :is="icon" aria-hidden="true" /></template>
