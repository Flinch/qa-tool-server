const subscribers = new Map() // project_id (string) -> Set<res>

export function subscribe(projectId, res) {
  const key = String(projectId)
  if (!subscribers.has(key)) subscribers.set(key, new Set())
  subscribers.get(key).add(res)
}

export function unsubscribe(projectId, res) {
  subscribers.get(String(projectId))?.delete(res)
}

export function broadcast(projectId, event, data) {
  const conns = subscribers.get(String(projectId))
  if (!conns) return
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of conns) res.write(payload)
}