import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import {DeterministicClient} from '../../src/inference/deterministic';
import {ModelTrace} from '../../src/client/components/ModelTrace';
import {modelPresentation,opponentPresentation} from '../../src/client/model-presentation';

it('keeps an actual deterministic adapter receipt visibly synthetic without changing its identity',async()=>{
 const {receipt}=await new DeterministicClient().complete({instructions:'Fixture only',input:'Fixture',purpose:'presentation-test'});
 const before=JSON.stringify(receipt);
 const html=renderToStaticMarkup(createElement(ModelTrace,{event:{id:'fixture',sequence:1,actor:'synthetic-test',tick:0,kind:'model_decision',summary:'Synthetic fixture',side:'blue',details:{receipt}}}));
 expect(html).toContain('Synthetic adapter · no model inference');
 expect(html).not.toContain('Kamiwaza deployed model');
 expect(JSON.stringify(receipt)).toBe(before);
});

it('does not present missing identity or an available but disabled opponent as platform inference',()=>{
 expect(modelPresentation({})).toBe('Model identity not reported');
 expect(opponentPresentation(undefined,'provider-model')).toBe('Opponent state not reported');
 expect(opponentPresentation(false,'Scripted reference · provider model available on request')).toBe('Off · scripted reference controller');
 expect(opponentPresentation(true,'deterministic-synthetic')).toBe('Synthetic adapter · no model inference');
});

it('uses the requested presentation name while retaining exact provider identity in the receipt',()=>{
 const receipt={modelRequested:'provider-original',modelReturned:'provider-revision'};
 const before={...receipt};
 expect(modelPresentation(receipt)).toBe('Connected model');
 expect(modelPresentation({...receipt,context:{inferenceRoute:'external-api'}})).toBe('Connected model');
 expect(modelPresentation({...receipt,context:{inferenceRoute:'kamiwaza-local'}})).toBe('Kamiwaza deployed model');
 expect(opponentPresentation(true,'provider-original','kamiwaza-local')).toBe('Kamiwaza deployed model');
 expect(opponentPresentation(true,'provider-original','external-api')).toBe('Connected model');
 expect(receipt).toEqual(before);
});
