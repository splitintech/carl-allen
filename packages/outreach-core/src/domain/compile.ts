import { purposePermitted, type CapabilitySnapshot, type ProviderPurpose, type SenderIdentity } from '@splitin/outreach-contracts';
import type { DomainEnv } from './env';
import type { ContentCalendar, Playbook } from './playbook';
import { findTemplate } from './templates';
export function executionAccountIssues(env: DomainEnv, workspaceId: string, kind: string, accountId: string, purpose: ProviderPurpose): string[] {
    const account = env.db.prepare('SELECT provider,purposes,capabilities,sender_identity FROM provider_accounts WHERE workspace_id=? AND id=?')
        .get<{
        provider: string;
        purposes: string;
        capabilities: string;
        sender_identity: string;
    }>(workspaceId, accountId);
    if (!account)
        return [`provider account ${accountId} does not exist in this workspace`];
    const adapter = env.adapters.get(account.provider);
    if (!adapter)
        return [`no adapter registered for provider ${account.provider}`];
    const caps = JSON.parse(account.capabilities || '{}') as CapabilitySnapshot;
    const social = kind.startsWith('social.');
    const need: ProviderPurpose = kind === 'social.publish' ? 'social_publishing' : social ? 'social_messaging' : purpose;
    const issues: string[] = [];
    if (!purposePermitted(need, adapter.purposes, JSON.parse(account.purposes) as ProviderPurpose[]))
        issues.push(`purpose ${need} is not permitted by both provider ${account.provider} and the account`);
    if (kind.startsWith('email.') && !adapter.email)
        issues.push(`provider ${account.provider} cannot send email`);
    if (social && !adapter.social)
        issues.push(`provider ${account.provider} has no social port (ADR 0006)`);
    if (social || kind === 'browser.task') {
        if (caps.executionPlacement !== 'daytona-browser')
            issues.push('social/browser steps require account executionPlacement daytona-browser (ADR 0006)');
        const supported = kind === 'social.publish' ? caps.socialPublish : kind === 'social.message' ? caps.socialMessage : kind === 'social.connect' ? caps.socialConnect : caps.browserTasks;
        if (supported !== true)
            issues.push(`${kind}: capability must be explicitly true`);
    }
    if (kind === 'social.connect' && !adapter.social?.connect)
        issues.push('provider has no social connect port');
    if (kind === 'browser.task' && !adapter.browser)
        issues.push('provider has no browser task port');
    return issues;
}
export function accountRecipeHash(env: DomainEnv, workspaceId: string, accountId: string, recipeId: string): string | null {
    const row = env.db.prepare('SELECT capabilities FROM provider_accounts WHERE workspace_id=? AND id=?').get<{
        capabilities: string;
    }>(workspaceId, accountId);
    const hash = row ? (JSON.parse(row.capabilities) as CapabilitySnapshot).browserRecipeHashes?.[recipeId] : undefined;
    return hash && /^[a-f0-9]{64}$/i.test(hash) ? hash : null;
}
function channelIssues(env: DomainEnv, workspaceId: string, accountId: string, channel: string): string[] {
    const row = env.db.prepare('SELECT capabilities FROM provider_accounts WHERE workspace_id=? AND id=?').get<{
        capabilities: string;
    }>(workspaceId, accountId);
    const channels = row ? (JSON.parse(row.capabilities) as CapabilitySnapshot).socialChannels : undefined;
    return channels && !channels.includes(channel) ? [`channel ${channel} is unsupported by account ${accountId}`] : [];
}
export function compileIssues(env: DomainEnv, workspaceId: string, playbook: Playbook, providerAccountId: string): string[] {
    const issues: string[] = [];
    const seen = new Set<string>();
    let sentBefore = false;
    for (const [index, step] of playbook.spec.steps.entries()) {
        const at = `steps[${index}] (${step.id})`;
        if (seen.has(step.id))
            issues.push(`${at}: duplicate step id`);
        seen.add(step.id);
        if (step.type === 'wait') {
            if (index === playbook.spec.steps.length - 1)
                issues.push(`${at}: a trailing wait has no effect`);
            continue;
        }
        if (step.type === 'email.reply' && !sentBefore)
            issues.push(`${at}: email.reply needs an earlier email.send to reply to`);
        if (step.type === 'email.send')
            sentBefore = true;
        if ('template' in step) {
            const t = findTemplate(env.db, workspaceId, step.template);
            if (!t)
                issues.push(`${at}: template ${step.template} does not exist`);
            else {
                const channels = step.type === 'manual.task' || step.type.startsWith('social.') ? [('channel' in step ? step.channel : ''), 'manual'] : ['email'];
                if (!channels.includes(t.channel))
                    issues.push(`${at}: template ${step.template} is for channel ${t.channel}`);
                if (step.type === 'email.send' && !t.subject)
                    issues.push(`${at}: template ${step.template} has no subject (only reply templates may omit it)`);
                if ((JSON.parse(t.required_tokens) as string[]).includes('unsubscribe_url') && !env.unsubscribe)
                    issues.push(`${at}: uses {{unsubscribe_url}} but no unsubscribe URL is configured`);
            }
        }
        if (step.type === 'manual.task')
            continue;
        const accountId = step.providerAccountId ?? providerAccountId;
        issues.push(...executionAccountIssues(env, workspaceId, step.type, accountId, playbook.spec.purpose));
        if (step.type === 'browser.task' && !accountRecipeHash(env, workspaceId, accountId, step.recipeId))
            issues.push(`browser recipe ${step.recipeId} must declare an immutable definition hash`);
        if ('channel' in step)
            issues.push(...channelIssues(env, workspaceId, accountId, step.channel));
        if (step.type.startsWith('email.')) {
            const a = env.db.prepare('SELECT sender_identity FROM provider_accounts WHERE workspace_id=? AND id=?').get<{
                sender_identity: string;
            }>(workspaceId, accountId);
            if (a && playbook.spec.policy.requirePostalAddress && !(JSON.parse(a.sender_identity) as SenderIdentity).postalAddress)
                issues.push('policy.requirePostalAddress: the sending account has no postal address');
            if (playbook.spec.policy.unsubscribe === 'link' && !env.unsubscribe)
                issues.push('policy.unsubscribe is "link" but no unsubscribe URL is configured (use "reply" or configure one)');
            if (!playbook.spec.audience.require.includes('email'))
                issues.push('email steps require email audience contact points');
        }
    }
    if (!playbook.spec.steps.some(s => s.type !== 'wait'))
        issues.push('steps: no actionable step');
    return [...new Set(issues)];
}
export function compileContentCalendarIssues(env: DomainEnv, workspaceId: string, calendar: ContentCalendar, providerAccountId: string): string[] {
    const issues: string[] = [];
    const seen = new Set<string>();
    for (const post of calendar.spec.posts) {
        if (seen.has(post.id))
            issues.push(`posts (${post.id}): duplicate post id`);
        seen.add(post.id);
        const t = findTemplate(env.db, workspaceId, post.template);
        if (!t)
            issues.push(`posts (${post.id}): template ${post.template} does not exist`);
        else if (![post.channel, 'manual'].includes(t.channel))
            issues.push(`posts (${post.id}): template ${post.template} is for channel ${t.channel}`);
        issues.push(...executionAccountIssues(env, workspaceId, 'social.publish', post.providerAccountId ?? providerAccountId, 'social_publishing'));
        issues.push(...channelIssues(env, workspaceId, post.providerAccountId ?? providerAccountId, post.channel));
    }
    return [...new Set(issues)];
}
