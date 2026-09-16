export function configuredModelPresentation(route?: 'kamiwaza-local'|'external-api'): string {
  return route==='kamiwaza-local'?'Kamiwaza deployed model':'Connected model';
}

/** Presentation names never replace the identity in an underlying receipt or export. */
export function modelPresentation(receipt: {modelReturned?: unknown; modelRequested?: unknown;context?:{inferenceRoute?:unknown}}): string {
  const names = [receipt.modelReturned, receipt.modelRequested].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
  if (names.some(name => /deterministic|synthetic|simulat|scripted|mock/i.test(name))) return 'Synthetic adapter · no model inference';
  return names.length ? configuredModelPresentation(receipt.context?.inferenceRoute==='kamiwaza-local'?'kamiwaza-local':undefined) : 'Model identity not reported';
}

/** A configured/available route does not establish that an opponent is enabled. */
export function opponentPresentation(enabled: boolean | undefined, model?: string, route?: 'kamiwaza-local'|'external-api'): string {
  if (enabled === false) return 'Off · scripted reference controller';
  if (enabled === undefined) return 'Opponent state not reported';
  return modelPresentation({modelRequested: model,context:{inferenceRoute:route}});
}
