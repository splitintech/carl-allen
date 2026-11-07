import {it,expect} from 'vitest';
import {WorkPackageManifest} from './work-package';
it.each([['contacts',10001],['media',1001],['publishingPlans',1001]] as const)('rejects oversized %s before allocating one validation issue per invalid element',(field,count)=>{
 const parsed=WorkPackageManifest.safeParse({schemaVersion:1,packageId:'bounded',revision:1,name:'Bounded import',timezone:'UTC',[field]:Array(count).fill(null)});
 expect(parsed.success).toBe(false);if(parsed.success)throw new Error('Oversized package unexpectedly accepted');
 expect(parsed.error.issues).toHaveLength(1);expect(parsed.error.issues[0]?.path).toEqual([field]);
});
