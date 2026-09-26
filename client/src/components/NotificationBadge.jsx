// one badge everywhere so the red circle looks the same
export function NotificationBadge({ count }) {
    if (!count) return null
    return <span className="notif-badge">{count > 99 ? "99+" : count}</span>
}
