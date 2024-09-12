// receiptGenerator.js
function generateReceipt(order) {
	return `
		Receipt #${order.receipt}
		==========================
		Product: ${order.product.name}
		Price per Product: ₹${order.pricePerProduct}
		Quantity: ${order.quantity}
		Total Products Price: ₹${order.totalProductsPrice}
		Delivery Charge (${order.deliveryCharge > 0 ? 'Expedited' : 'Standard'}): ₹${order.deliveryCharge}
		---------------------------
		Total Amount: ₹${order.totalAmount}
		==========================
		Thank you for your order!
	`;
}

// Export the function
module.exports = generateReceipt;
