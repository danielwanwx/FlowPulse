// The only executable local repair is for the checked-in checkout payment flag.
// Keep this predicate narrower than a generic service-error check.
export function isCheckoutPaymentUnreachableTrace(record) {
  const trace = record?.value?.trace || {};
  const services = [record?.entity, trace.service, ...(record?.value?.services || [])]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
  const dependency = `${trace.peer_target || ""} ${trace.operation || ""}`.toLowerCase();
  const failure = `${trace.error || ""}`.toLowerCase();
  const networkFailure = /econnrefused|connection refused|unavailable|connect(?:ion)? (?:failed|refused)|network unreachable|name resolver error|produced zero addresses|no such host|dns lookup/.test(failure);
  return record?.kind === "trace"
    && services.some((service) => service.includes("checkout"))
    && dependency.includes("payment")
    // A bounded network error is sufficient when an exporter omitted status.
    && networkFailure;
}
