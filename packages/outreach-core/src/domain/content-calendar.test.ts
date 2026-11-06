import { describe, expect, it } from 'vitest';
import { activateContentCampaign, createContentCampaign, listContentCalendar } from './content-calendar';
import { compileContentCalendarIssues } from './compile';
import { makeDomainEnv, PLAYBOOK } from './domain.test-util';
import { parseContentCalendar, PlaybookError } from './playbook';
import { registerProviderAccount } from './operations';
import { createTemplate } from './templates';

const CALENDAR = `
apiVersion: outreach.splitin.net/v1alpha1
kind: ContentCalendar
metadata: { name: launch-week }
spec:
  purpose: social_publishing
  policy:
    approval: none
    window:
      timezone: America/New_York
      days: [Mon, Tue, Wed, Thu, Fri]
      start: "09:00"
      end: "17:00"
    limits: { accountPerDay: 5, channelPerDay: 3 }
  posts:
    - { id: mon, channel: linkedin, template: post@1, scheduledFor: "2099-01-05T15:00:00.000Z" }
`;

describe('content calendar', () => {
  it('parses and compiles only for daytona-browser social accounts', async () => {
    const env = await makeDomainEnv();
    createTemplate(env.engine.db, env.operator, { name: 'post', channel: 'linkedin', text: 'Ship {{sender_name}}' }, env.now());
    const calendar = parseContentCalendar(CALENDAR);
    expect(compileContentCalendarIssues(env.engine, 'ws', calendar, env.accountId).join('\n')).toMatch(
      /daytona-browser|social port|social_publishing/,
    );

    const socialId = await registerProviderAccount(env.engine, env.admin, {
      provider: 'fake-social',
      externalAccountId: 'li-ops',
      sender: { name: 'Ops', address: 'ops@example.com' },
      purposes: ['social_publishing', 'social_messaging'],
      secretRef: 'env:FAKE_SOCIAL',
      executionPlacement: 'daytona-browser',
    });
    expect(compileContentCalendarIssues(env.engine, 'ws', calendar, socialId)).toEqual([]);
  });

  it('materializes social.publish rows onto scheduled_actions', async () => {
    const env = await makeDomainEnv();
    createTemplate(env.engine.db, env.operator, { name: 'post', channel: 'linkedin', text: 'Ship {{sender_name}}' }, env.now());
    const socialId = await registerProviderAccount(env.engine, env.admin, {
      provider: 'fake-social',
      externalAccountId: 'li-ops',
      sender: { name: 'Ops', address: 'ops@example.com' },
      purposes: ['social_publishing', 'social_messaging'],
      secretRef: 'env:FAKE_SOCIAL',
      executionPlacement: 'daytona-browser',
    });
    const { campaignId } = createContentCampaign(env.engine, env.operator, {
      name: 'Launch',
      calendar: CALENDAR,
      providerAccountId: socialId,
    });
    const { scheduled } = activateContentCampaign(env.engine, env.operator, campaignId);
    expect(scheduled).toBe(1);
    const calendar = listContentCalendar(env.engine, env.operator, 24 * 365 * 80);
    expect(calendar.posts).toHaveLength(1);
    expect(calendar.posts[0]?.channel).toBe('linkedin');
    expect(calendar.posts[0]?.text).toMatch(/Ship Ops/);
    expect(() =>
      createContentCampaign(env.engine, env.operator, { name: 'x', calendar: PLAYBOOK, providerAccountId: socialId }),
    ).toThrow(PlaybookError);
  });
});
