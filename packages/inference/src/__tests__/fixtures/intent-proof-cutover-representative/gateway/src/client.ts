export async function loadOrders() {
  return axios.get('http://orders/api/orders');
}
