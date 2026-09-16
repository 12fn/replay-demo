import type {BudgetLimit, BudgetUsage} from '../inference/allowance';
import {fmtUsd} from './lib';

export const requestAllowance=(value:BudgetLimit)=>value==='unlimited'?'Unlimited':String(value);
export const dollarAllowance=(value:BudgetLimit)=>value==='unlimited'?'Unlimited':fmtUsd(value);
export function budgetCapReached(budget:BudgetUsage):boolean {
  return (typeof budget.maxRequests==='number'&&budget.requestsUsed>=budget.maxRequests)
    ||(typeof budget.maxUsd==='number'&&budget.maxUsd>0&&budget.committedUsd>=budget.maxUsd);
}
export function budgetUsageText(budget:BudgetUsage):string {
  return `${fmtUsd(budget.committedUsd)} / ${dollarAllowance(budget.maxUsd)} · ${budget.requestsUsed}/${requestAllowance(budget.maxRequests)} requests`;
}
