export class DomainRuleOperationDeferredError extends Error {
  override readonly name = "DomainRuleOperationDeferredError";
}

export class DomainRulePreparedVetoError extends Error {
  override readonly name = "DomainRulePreparedVetoError";
}
