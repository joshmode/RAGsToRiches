// cover letters number per company unlike resume attempts
export function numberClAtts(list) {
    const groups = {}
    for (const item of list) {
        const key = (item.company || "").trim().toLowerCase() || "__unknown__"
        ;(groups[key] = groups[key] || []).push(item)
    }
    const numberOf = {}
    for (const items of Object.values(groups)) {
        const ascending = [...items].reverse()
        ascending.forEach((item, i) => { numberOf[item.id] = i + 1 })
    }
    return numberOf
}
