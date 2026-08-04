import "@testing-library/jest-dom/vitest";

// jsdom exposes the element but not its modal API. Keep the shared dialog
// primitives testable from any feature suite, not only their own unit tests.
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.open = true;
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.open = false;
  this.dispatchEvent(new Event("close"));
};
