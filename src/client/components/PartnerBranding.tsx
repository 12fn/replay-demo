/** Supplied marks belong to the application shell, never to evidence records or exports. */
export function PartnerBranding({className = ''}: {className?: string}) {
  return <div className={`partner-branding ${className}`} aria-label="Kamiwaza and Computacenter">
    <span className="partner-kamiwaza"><img src="/brands/kamiwaza-mark-green.png" alt="" width="24" height="24" /><span>Kamiwaza</span></span>
    <img className="partner-computacenter" src="/brands/computacenter-wordmark-blue.png" alt="Computacenter" />
  </div>;
}
