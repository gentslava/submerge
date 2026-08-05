export class DomainRuleOperationDeferredError extends Error {
  override readonly name = "DomainRuleOperationDeferredError";
}

export class DomainRuleWorkerNotAcceptingError extends Error {
  override readonly name = "DomainRuleWorkerNotAcceptingError";
}

export class DomainRulePreparedVetoError extends Error {
  override readonly name = "DomainRulePreparedVetoError";
}
