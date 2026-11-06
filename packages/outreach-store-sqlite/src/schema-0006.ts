import { SCHEMA_0005 } from './schema-0005';
/** Add action kinds without changing historical applied migration digests. */
export const SCHEMA_0006 = SCHEMA_0005.slice(SCHEMA_0005.indexOf('CREATE TABLE scheduled_actions_0005'))
  .replaceAll('scheduled_actions_0005', 'scheduled_actions_0006')
  .replace("'social.publish','social.message'", "'social.publish','social.message','social.connect','browser.task'");
