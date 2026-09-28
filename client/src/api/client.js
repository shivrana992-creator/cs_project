import axios from 'axios'

const client = axios.create({ baseURL: '/api', withCredentials: true, headers: { 'Content-Type': 'application/json' } })
client.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401 && !error.config?.url?.startsWith('/auth/')) {
      window.dispatchEvent(new CustomEvent('symposihub:session-expired'))
    }
    return Promise.reject(error)
  },
)
export default client
