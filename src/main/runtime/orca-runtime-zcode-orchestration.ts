// @ts-nocheck -- runtime mixin: the inherited surface is assembled across split OrcaRuntime classes.
import { OrcaRuntimeWithResolveWaiter } from './orca-runtime-resolve-waiter'
import type { AgentLaunchPreferences } from '../../shared/agent-session-host-authority'
import { repoIsRemote } from '../../shared/agent-launch-remote'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../shared/tui-agent-launch-defaults'
import { requiresOrchestrationStartupPrompt } from '../../shared/tui-agent-orchestration'
import { buildAgentStartupPlan } from '../../shared/tui-agent-startup'
import { resolveLocalWindowsAgentStartupShell } from '../../shared/windows-terminal-shell'
import type { RuntimeTerminalCreate, RuntimeTerminalSend } from '../../shared/runtime-types'
import { resolveZcodePromptDelivery } from '../zcode/interactive-client'
import {
  waitForWorktreeStartupDraft,
  waitForWorktreeStartupFollowup
} from './runtime-worktree-startup-readiness'

export class OrcaRuntimeWithZcodeOrchestration extends OrcaRuntimeWithResolveWaiter {
  async resolveOrchestrationPromptDelivery(
    agent: TuiAgent,
    worktreeId: string
  ): Promise<'agent-input' | 'startup-command'> {
    if (!requiresOrchestrationStartupPrompt(agent)) {
      return 'agent-input'
    }
    if (agent !== 'zcode' || !this.store) {
      return 'startup-command'
    }
    const worktree = await this.resolveWorktreeSelector(`id:${worktreeId}`)
    const repo = this.store.getRepo(worktree.repoId)
    if (!repo) {
      return 'startup-command'
    }
    return resolveZcodePromptDelivery({
      isRemote: repoIsRemote(repo),
      commandOverride: this.store.getSettings().agentCmdOverrides?.zcode?.trim()
    })
  }

  async resolveOrchestrationInteractiveAgentCommand(
    agent: TuiAgent,
    worktreeId: string
  ): Promise<string | undefined> {
    if (agent !== 'zcode' || !this.store) {
      return undefined
    }
    const worktree = await this.resolveWorktreeSelector(`id:${worktreeId}`)
    const repo = this.store.getRepo(worktree.repoId)
    if (!repo) {
      return undefined
    }
    const settings = this.store.getSettings()
    const platform = this.getAgentLaunchPlatformForRepo(repo)
    const isRemote = repoIsRemote(repo)
    const shell = resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: settings.terminalWindowsShell
    })
    return buildAgentStartupPlan({
      agent,
      prompt: '',
      cmdOverrides: settings.agentCmdOverrides ?? {},
      agentArgs: resolveTuiAgentLaunchArgs(agent, settings.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(agent, settings.agentDefaultEnv),
      platform,
      shell,
      isRemote,
      allowEmptyPromptLaunch: true
    })?.launchCommand
  }

  async createDeferredAgentTerminal(
    worktreeSelector: string,
    opts: {
      agent: TuiAgent
      launchPreferences?: AgentLaunchPreferences
      bareShell?: boolean
      title?: string
      surfaceOwner?: false
    }
  ): Promise<RuntimeTerminalCreate> {
    const worktree = await this.resolveWorktreeSelector(worktreeSelector)
    if (opts.bareShell) {
      return this.createTerminal(`id:${worktree.id}`, {
        title: opts.title,
        ...(opts.surfaceOwner === false ? { surfaceOwner: false } : {})
      })
    }
    return this.createTerminal(`id:${worktree.id}`, {
      startupAgent: opts.agent,
      ...(opts.launchPreferences ? { launchPreferences: opts.launchPreferences } : {}),
      title: opts.title,
      ...(opts.surfaceOwner === false ? { surfaceOwner: false } : {})
    })
  }

  async waitForTerminalAgentProcess(
    handle: string,
    agent: TuiAgent,
    _timeoutMs = 4_500
  ): Promise<boolean> {
    return (
      (await waitForWorktreeStartupFollowup(
        this.getWorktreeStartupReadinessHost(),
        handle,
        TUI_AGENT_CONFIG[agent].expectedProcess
      )) !== null
    )
  }

  async waitForTerminalAgentInputReady(handle: string, agent: TuiAgent): Promise<boolean> {
    return (
      (await waitForWorktreeStartupDraft(this.getWorktreeStartupReadinessHost(), handle, agent)) !==
      null
    )
  }

  async waitForTerminalProviderSession(
    handle: string,
    agent: TuiAgent,
    observedAfter: number,
    timeoutMs = 10_000
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() <= deadline) {
      if (this.getExactWorkerProviderSession(handle, observedAfter)?.agent === agent) {
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    return false
  }

  async sendTerminalAgentStartupPrompt(
    handle: string,
    agent: TuiAgent,
    prompt: string,
    launchPreferences?: AgentLaunchPreferences
  ): Promise<RuntimeTerminalSend> {
    const terminal = await this.showTerminal(handle)
    const worktree = await this.resolveWorktreeSelector(`id:${terminal.worktreeId}`)
    const repo = this.store?.getRepo(worktree.repoId)
    if (!repo) {
      throw new Error('Repository for the selected workspace is no longer available.')
    }
    const startup = this.buildStartupForAgent(repo, agent, prompt, launchPreferences)
    if (startup.followup) {
      throw new Error(`${agent} does not support startup-command prompt delivery.`)
    }
    return this.sendTerminalAgentPrompt(handle, startup.startup.command)
  }
}
