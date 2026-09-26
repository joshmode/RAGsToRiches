export function getError(err) {
    return err.response?.data?.error || err.message || "Something went wrong."
}

// blob requests get errors back as a blob too, decode for the real message
export async function getBlobError(err) {
    const data = err.response?.data
    if (data instanceof Blob && data.type.includes("json")) {
        try {
            return JSON.parse(await data.text()).error || getError(err)
        } catch {
            return getError(err)
        }
    }
    return getError(err)
}
