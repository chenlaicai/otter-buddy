/** Custom SVG otter head icon - NOT Lucide paw-print (← UA-13) */
export function OtterIcon({ className = 'w-5 h-5 text-otter-500' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <ellipse cx="7.5" cy="7" rx="2.2" ry="2.5" />
      <ellipse cx="16.5" cy="7" rx="2.2" ry="2.5" />
      <ellipse cx="12" cy="14" rx="6.5" ry="7" />
      <circle cx="9.5" cy="12.5" r="1" fill="#fff" />
      <circle cx="14.5" cy="12.5" r="1" fill="#fff" />
      <ellipse cx="12" cy="16" rx="1.4" ry="0.9" fill="#fff" />
    </svg>
  )
}
