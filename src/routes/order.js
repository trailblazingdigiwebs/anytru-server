const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');

// Bring in Models & Utils
const Order = require('../models/Order');
const Product = require('../models/Product');
const User = require('../models/User');
const auth = require('../middleware/auth');
const Address = require('../models/Adress');
const mailgun = require('../services/mailgun');
const crypto = require('crypto');
const Razorpay = require('razorpay');
const keys = require('../config/keys');
const role = require('../middleware/role');
const NotificationService = require('../services/notificationService');
const { ROLES, ORDER_ITEM_STATUS, ORDER_PAYMENT_STATUS, ENDPOINT, DELIVERY_TYPE } = require('../constants');
const razorpayInstance = require('../services/razorPay');
const Ads = require('../models/Ads');

// Checkout single order route
router.post('/checkoutSingle', auth, async (req, res) => {
	const { productId, offerId, addressId, quantity = 1 } = req.body;
	const { deliveryType } = req.query;
	const userId = req.user._id;

	// Validate required fields
	if (!productId || !offerId) {
		return res.status(404).json({ error: 'Please provide productId and offerId' });
	}
	if (!addressId) {
		return res.status(404).json({ error: 'Please provide address' });
	}
	if (!deliveryType) {
		return res.status(404).json({ error: 'Please provide deliveryType' });
	}
	if (deliveryType !== DELIVERY_TYPE.expedite && deliveryType !== DELIVERY_TYPE.standard) {
		return res.status(404).json({ error: 'Invalid deliveryType provided' });
	}

	if(!req.user){
		return res.status(401).json({error:'user not authorized'})
	}
	const user = await User.findById(req.user)
	if(!user){
		return res.status(404).json({ error: 'user not found' });

	}
	if (!user.phoneNumber) {
		return res.status(406).json({ error: 'Please provide phone number in your profile section' });

	}
		try {
			// Fetch the address
			const address = await Address.findOne({ _id: addressId, user: userId });
			if (!address) {
				return res.status(404).json({ error: 'Address not found' });
			}

			// Fetch the product and offer details
			const findOffer = await Product.findOne({ _id: productId, 'offers._id': offerId, isActive: true }).populate(
				'user',
				'_id firstName lastName email userId phoneNumber'
			);

			if (!findOffer) {
				return res.status(404).json({ error: 'Offer not found' });
			}

			// Calculate delivery charge and total price
			const acceptedOffer = findOffer.offers.find((offer) => offer._id.toString() === offerId);
			const deliveryCharge =
				deliveryType === DELIVERY_TYPE.expedite ? acceptedOffer.expediteDeliveryPrice : acceptedOffer.standardDeliveryPrice;
			const totalProductsPrice = acceptedOffer.pricePerProduct * quantity;
			const totalAmount = totalProductsPrice + deliveryCharge;

			// Create the Razorpay order
			const options = {
				amount: totalAmount * 100, // Amount in paisa
				currency: 'INR',
				receipt: `receipt_${Date.now()}`,
				payment_capture: 1
			};
			const order = await razorpayInstance.orders.create(options);
			if (!order) {
				return res.status(400).json({ error: 'Order creation failed' });
			}

			// Prepare order data for saving
			const orderData = {
				orderId: order.id,
				user: findOffer.user,
				paymentStatus: ORDER_PAYMENT_STATUS.Created,
				product: findOffer,
				quantity,
				vendor: acceptedOffer.vendor,
				pricePerProduct: acceptedOffer.pricePerProduct,
				totalProductsPrice,
				delivery: {
					charges: deliveryCharge, // Store delivery charges
					deliveryType: deliveryType // Store delivery type
				},
				totalAmount,
				remark: acceptedOffer.remark,
				dispatchDay: acceptedOffer.dispatchDay,
				address,
				receipt: order.receipt,
				amount_due: order.amount_due,
				amount_paid: order.amount_paid,
				attempts: order.attempts,
				currency: order.currency,
				offer_id: offerId,
				created_at: order.created_at
			};

			// Save the order in the database
			const newOrder = new Order(orderData);
			const orderDoc = await newOrder.save();

			// Respond with order details
			res.status(200).json({
				success: true,
				message: 'Your order has been created successfully!',
				orderDoc,
				order
			});
		} catch (error) {
			console.error(error);
			res.status(400).json({
				error: 'Your request could not be processed. Please try again.'
			});
		}
});


// add get by user
//vendor
// Payment verification route

router.post('/verificationPay', async (req, res) => {
	try {
		const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

		const order = await Order.findOne({ orderId: razorpay_order_id })
			.populate({ path: 'vendor', select: '_id', populate: { path: 'user' } })
			.populate('user');
		if (!order) {
			return res.status(404).json({ error: 'Order not found' });
		}

		const body = razorpay_order_id + '|' + razorpay_payment_id;
		const expectedSignature = crypto.createHmac('sha256', keys.razorpay.secretAccessKey).update(body.toString()).digest('hex');

		const isAuthentic = expectedSignature === razorpay_signature;

		if (isAuthentic) {
			order.paymentId = razorpay_payment_id;
			order.paymentSignature = razorpay_signature;
			order.paymentStatus = ORDER_PAYMENT_STATUS.Captured;

			const notificationData = {
				userId: order.vendor.user,
				title: order.product.name,
				avatar: order.user.avatar || '',
				message: `Your offer is accepted by ${order.user}`,
				url: `${ENDPOINT.Order}${order.orderId}`,
				imgUrl: order.product.imageUrl || ''
			};
			const notification = await NotificationService.createNotification(notificationData);

			const acceptedOffer = {
				vendor: order.vendor,
				pricePerProduct: order.pricePerProduct,
				dispatchDay: order.dispatchDay,
				remark: order.remark
			};
			const updateAds = await Ads.findByIdAndUpdate(order.ad, { acceptedOffer, isActive: false }, { new: true });
			await mailgun.sendEmail(order.user.email, 'order-confirmation', '', order); //mail to user
			await mailgun.sendEmail(order.vendor.user.email, 'order-confirmation-vendor', '', order); //mail to vendor
		} else {
			order.paymentStatus = ORDER_PAYMENT_STATUS.Failed;
		}

		await order.save();

		res.status(isAuthentic ? 200 : 400).json({
			success: isAuthentic,
			message: isAuthentic ? `Order status updated to ${order.paymentStatus}` : 'Invalid signature',
			order
		});
	} catch (error) {
		console.error('Error during payment verification:', error);
		res.status(500).json({
			error: 'Internal Server Error'
		});
	}
});
// Payment refund route
router.post('/refund', auth, role.check(ROLES.Admin), async (req, res) => {
	try {
		const paymentId = req.body.paymentId;
		const findOrder = await Order.findOne({ paymentId });

		if (!findOrder) {
			return res.status(404).json({ error: 'No order found' });
		}

		if (findOrder.paymentStatus !== ORDER_PAYMENT_STATUS.Captured) {
			return res.status(403).json({ error: `Payment not captured or status is ${findOrder.paymentStatus}` });
		}

		if (findOrder.orderStatus !== ORDER_ITEM_STATUS.Cancelled) {
			return res.status(403).json({ error: `Order cannot be refunded because it is already ${findOrder.orderStatus}` });
		}

		const amount = findOrder.totalAmount * 100; // amount in paise

		const options = {
			payment_id: paymentId,
			amount: amount,
			receipt: `receipt_${Date.now()}`
		};

		const razorpayResponse = await razorpayInstance.payments.refund(options);

		if (!razorpayResponse) {
			return res.status(400).json({ error: 'Refund request failed. Please check the payment ID and try again.' });
		}

		findOrder.paymentStatus = ORDER_PAYMENT_STATUS.Refunded;
		await findOrder.save();

		res.status(201).json({
			message: 'Refund initiated successfully',
			razorpayResponse
		});
	} catch (error) {
		console.error('Error during refund:', error);
		if (error.statusCode) {
			res.status(error.statusCode).json({ error: error.message || 'Error during refund process' });
		} else {
			res.status(500).json({ error: 'Internal Server Error' });
		}
	}
});

// Search orders API
router.get('/search', auth, role.check(ROLES.Admin), async (req, res) => {
	try {
		const { search } = req.query;

		if (!search) {
			return res.status(400).json({ error: 'Search query is required.' });
		}

		const order = await Order.findOne({ orderId: search.toString() }, { _id: 0, receipt: 0, paymentSignature: 0, paymentId: 0 })
			.sort('-createdAt')
			.populate({ path: 'user', select: 'name email avatar _id' })
			.populate({ path: 'vendor', select: 'user rating vendorId isActive', populate: { path: 'user', select: 'avatar userId' } });

		if (!order) {
			return res.status(404).json({ error: `No order found with orderId ${search}` });
		}

		res.status(200).json({ order });
	} catch (error) {
		console.error('Error fetching order:', error);
		res.status(500).json({
			error: 'Your request could not be processed. Please try again later.'
		});
	}
});

// fetch orders api vendor
router.get('/vendor/:vendorId', auth, async (req, res) => {
	const vendorId = req.params.vendorId;
	try {
		const { page = 1, limit = 10, orderStatus } = req.query;

		// Create a query object
		const query = {
			vendor: vendorId,
			paymentStatus: { $in: [ORDER_PAYMENT_STATUS.Refunded, ORDER_PAYMENT_STATUS.Captured] }
		};

		// Add orderStatus to the query if provided
		if (orderStatus) {
			query.orderStatus = orderStatus;
		}

		const ordersDoc = await Order.find(query)
			.sort({ orderStatus: 1, createdAt: -1 }) // Sort by orderStatus and then by createdAt
			.populate({ path: 'user', select: 'phoneNumber name lastName email userId avatar accountType isActive _id' })
			.limit(limit * 1)
			.skip((page - 1) * limit)
			.exec();

		const count = await Order.countDocuments(query);

		if (!ordersDoc.length) {
			return res.status(404).json({ error: 'No orders found' });
		}

		res.status(200).json({
			ordersDoc,
			totalPages: Math.ceil(count / limit),
			currentPage: Number(page),
			count
		});
	} catch (error) {
		console.log(error);
		res.status(400).json({
			error: 'Your request could not be processed. Please try again.'
		});
	}
});

// fetch orders api
router.get('/user/:userId', auth, async (req, res) => {
	const userId = req.params.userId;
	try {
		const { page = 1, limit = 10 } = req.query;
		const ordersDoc = await Order.find({ user: userId })
			.sort('-createdAt')
			.populate({
				path: 'vendor',
				populate: {
					path: 'user',
					select: 'userId avatar accountType isActive _id'
				},
				select: 'merchantAddress _id vendorId rating description isActive'
			})
			.limit(limit * 1)
			.skip((page - 1) * limit)
			.exec();

		const count = await Order.countDocuments();
		// const orders = store.formatOrders(ordersDoc);

		if (!ordersDoc) {
			return res.status(404).json({ error: 'No any order found' });
		}

		res.status(200).json({
			// orders,
			ordersDoc,
			totalPages: Math.ceil(count / limit),
			currentPage: Number(page),
			count
		});
	} catch (error) {
		console.log(error);
		res.status(400).json({
			error: 'Your request could not be processed. Please try again.'
		});
	}
});

// fetch orders api by admin
router.get('/', auth, role.check(ROLES.Admin), async (req, res) => {
	try {
		const { page = 1, limit = 10, orderStatus, paymentStatus, totalAmount } = req.query;

		// Create a query object
		const query = {};

		// Add orderStatus to the query if provided
		if (orderStatus) {
			query.orderStatus = orderStatus;
		}

		// Add paymentStatus to the query if provided
		if (paymentStatus) {
			query.paymentStatus = paymentStatus;
		}

		// Determine sort order for totalAmount
		let sortOptions = { createdAt: -1 }; // Default sort by createdAt descending
		if (totalAmount) {
			sortOptions = { totalAmount: totalAmount === 'asc' ? 1 : -1 };
		}

		const ordersDoc = await Order.find(query)
			.sort(sortOptions)
			.populate({
				path: 'vendor',
				populate: {
					path: 'user',
					select: 'userId avatar accountType isActive _id'
				},
				select: 'merchantAddress _id vendorId rating description isActive'
			})
			.populate({ path: 'user', select: 'phoneNumber name lastName email userId avatar accountType isActive _id' })
			.limit(limit * 1)
			.skip((page - 1) * limit)
			.exec();

		const count = await Order.countDocuments(query);

		res.status(200).json({
			ordersDoc,
			totalPages: Math.ceil(count / limit),
			currentPage: Number(page),
			count
		});
	} catch (error) {
		console.log(error);
		res.status(400).json({
			error: 'Your request could not be processed. Please try again.'
		});
	}
});

// fetch order api by orderId
router.get('/:orderId', auth, async (req, res) => {
	try {
		const orderId = req.params.orderId;

		let orderDoc = null;

		orderDoc = await Order.findOne({ orderId: orderId.toString() })
			.populate({
				path: 'vendor',
				populate: {
					path: 'user'
				}
			})
			.populate({ path: 'user' });

		if (!orderDoc) {
			return res.status(404).json({
				message: `Cannot find order with the id: ${orderId}.`
			});
		}

		res.status(200).json({
			orderDoc
		});
	} catch (error) {
		res.status(400).json({
			error: 'Your request could not be processed. Please try again.'
		});
	}
});

// Cancel single order item API
//sending mail
// sending notifiaction
router.delete('/cancel/item', auth, role.check(ROLES.Admin, ROLES.Merchant), async (req, res) => {
	const { orderId } = req.body;

	let findOrder;

	console.log(req.user);
	try {
		if (req.user.role == ROLES.Admin) {
			findOrder = await Order.findOne({ orderId: orderId });
		} else {
			findOrder = await Order.findOne({ orderId: orderId, vendor: req.user.vendor });
		}

		if (!findOrder) {
			return res.status(404).json({ error: 'No single order found' });
		}

		if (!findOrder) {
			return res.status(404).json({ error: 'No single order found' });
		}

		if (findOrder.orderStatus == ORDER_ITEM_STATUS.Processing) {
			return res.status(403).json({ error: `Order is already ${ORDER_ITEM_STATUS.Processing}` });
		}
		if (findOrder.orderStatus == ORDER_ITEM_STATUS.Shipped) {
			return res.status(403).json({ error: `Order is already ${ORDER_ITEM_STATUS.Shipped}` });
		}
		if (findOrder.orderStatus == ORDER_ITEM_STATUS.Delivered) {
			return res.status(403).json({ error: `Order is already ${ORDER_ITEM_STATUS.Delivered}` });
		}
		if (findOrder.orderStatus == ORDER_ITEM_STATUS.Cancelled) {
			return res.status(403).json({ error: `Order is already ${ORDER_ITEM_STATUS.Cancelled}` });
		}

		findOrder.orderStatus = ORDER_ITEM_STATUS.Cancelled;

		const updatedOrder = await findOrder.save();

		res.status(200).json({
			updatedOrder,
			success: true,
			message: 'Order has been cancelled successfully'
		});
	} catch (error) {
		console.error('Error cancelling the order:', error);
		res.status(400).json({
			error: 'Your request could not be processed. Please try again.'
		});
	}
});

// Update status of a single order item
//sending mail
// sending notication
router.put('/status/item', auth, role.check(ROLES.Admin, ROLES.Merchant), async (req, res) => {
	try {
		const { orderId, orderStatus } = req.body;

		let findOrder;
		if (req.user.role === ROLES.Admin) {
			findOrder = await Order.findOne({ orderId });
		} else {
			findOrder = await Order.findOne({ orderId, vendor: req.user.vendor });
		}

		if (!findOrder) {
			return res.status(404).json({ error: 'No order found' });
		}

		if (!Object.values(ORDER_ITEM_STATUS).includes(orderStatus)) {
			return res.status(400).json({ error: `Invalid status: ${orderStatus}. Please select a valid status.` });
		}

		const currentStatus = findOrder.orderStatus;
		if (currentStatus === ORDER_ITEM_STATUS.Cancelled) {
			return res.status(403).json({ error: 'Cannot update status of a cancelled order.' });
		}

		const validStatusTransitions = {
			[ORDER_ITEM_STATUS.Not_processed]: [ORDER_ITEM_STATUS.Processing, ORDER_ITEM_STATUS.Cancelled],
			[ORDER_ITEM_STATUS.Processing]: [ORDER_ITEM_STATUS.Shipped, ORDER_ITEM_STATUS.Cancelled],
			[ORDER_ITEM_STATUS.Shipped]: [ORDER_ITEM_STATUS.Delivered, ORDER_ITEM_STATUS.Cancelled],
			[ORDER_ITEM_STATUS.Delivered]: [],
			[ORDER_ITEM_STATUS.Cancelled]: []
		};

		if (!validStatusTransitions[currentStatus].includes(orderStatus)) {
			return res.status(403).json({
				error: `Invalid status transition from ${currentStatus} to ${orderStatus}.`
			});
		}

		findOrder.orderStatus = orderStatus;
		await findOrder.save();

		const notificationData = {
			userId: findOrder.user,
			title: 'Order Status Update',
			message: `Your order has been ${findOrder.orderStatus}`,
			url: `${process.env.ENDPOINT}/order/${findOrder._id}`,
			imgUrl: findOrder.product.imageUrl || '' // Ensure there is a default if no imageUrl exists
		};
		await NotificationService.createNotification(notificationData);

		res.status(200).json({
			success: true,
			message: 'Item status has been updated successfully!',
			order: findOrder
		});
	} catch (error) {
		console.error('Error updating order item status:', error);
		res.status(500).json({
			error: 'An error occurred while processing your request. Please try again.'
		});
	}
});

module.exports = router;
