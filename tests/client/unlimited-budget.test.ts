import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {expect,it} from 'vitest';
import type {ViewContext} from '../../src/client/App';
import {PlatformView} from '../../src/client/views/PlatformView';
import {budgetCapReached,budgetUsageText,dollarAllowance,requestAllowance} from '../../src/client/budget-presentation';

it('keeps actual usage visible above old limits without false cap blocking or ambiguous numbers',()=>{
 const budget={allowance:'unlimited' as const,maxUsd:'unlimited' as const,maxRequests:'unlimited' as const,requestsUsed:120,committedUsd:6.25};
 expect(budgetCapReached(budget)).toBe(false);expect(budgetUsageText(budget)).toBe('$6.25 / Unlimited · 120/Unlimited requests');
 expect(requestAllowance('unlimited')).toBe('Unlimited');expect(dollarAllowance('unlimited')).toBe('Unlimited');
 expect(budgetCapReached({...budget,maxRequests:100,maxUsd:5})).toBe(true);
 expect(budgetCapReached({...budget,requestsUsed:2,maxRequests:100,maxUsd:0,committedUsd:0})).toBe(false);
});

it('renders real Platform usage with Unlimited and no numeric spend meter',()=>{
 const ctx={ov:{identity:{subject:'synthetic',mode:'local-demo'},platform:{nativeConnected:false,details:[],mode:'local-demo',requests:120,spentUsd:6.25,capUsd:'unlimited',traceCount:3,inferenceRoute:'external-api'},exercises:[],state:{fingerprint:'synthetic',tick:0},activeId:'synthetic',playbackTick:null}} as unknown as ViewContext;
 const html=renderToStaticMarkup(createElement(PlatformView,{ctx}));
 expect(html).toContain('Unlimited application allowance');expect(html).toContain('$6.25');expect(html).toContain('120');
 expect(html).not.toContain('Spend against cap');expect(html).not.toMatch(/NaN|Infinity|undefined|null/);
});
