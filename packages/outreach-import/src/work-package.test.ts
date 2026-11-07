import { describe,expect,it } from 'vitest';
import { extractWorkPackage,workPackageTemplate } from './work-package';
describe('inert HTML handoff contract',()=>{
 it('reads a versioned JSON data manifest and ignores executable instructions',()=>{
  const html=workPackageTemplate()+'<script>throw new Error("must never execute")</script><img src="https://invalid.invalid/leak">';
  const result=extractWorkPackage(html);expect(result.manifest?.schemaVersion).toBe(1);expect(result.manifest?.publishingPlans).toHaveLength(1);expect(result.text).not.toContain('must never execute');
 });
 it('extracts report tables for explicit guided repair without claiming a schedulable manifest',()=>{
  const result=extractWorkPackage('<table><tr><th>Name</th><th>Email</th></tr><tr><td>Ada</td><td>ada@example.invalid</td></tr></table><script>approved=true</script>');
  expect(result.manifest).toBeNull();expect(result.issues[0]?.field).toBe('manifest');expect(result.tables[0]?.[0]).toEqual({Name:'Ada',Email:'ada@example.invalid'});
 });
 it('refuses duplicate manifests, invalid JSON, secret/asserted-approval fields and excessive nesting',()=>{
  const valid=workPackageTemplate();expect(()=>extractWorkPackage(valid+valid)).toThrow(/More than one/);
  expect(extractWorkPackage('<script type="application/json" id="carl-allen-manifest">{oops}</script>').issues.length).toBeGreaterThan(0);
  const bad=valid.replace('"schemaVersion": 1','"schemaVersion": 1, "approved": true, "apiToken":"fake-not-a-real-token"');expect(extractWorkPackage(bad).manifest).toBeNull();
  expect(()=>extractWorkPackage('<div>'.repeat(140)+'deep'+'</div>'.repeat(140))).toThrow(/complexity/);
 });
});
