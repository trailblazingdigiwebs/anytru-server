const express = require('express');
const router = express.Router();
const multer = require('multer');
const Mongoose = require('mongoose');

// Bring in Models & Utils
// const Product = require('../models/Product');
const Product = require('../models/Product');
const Vendor = require('../models/Vendor');
const Report = require('../models/Report');
const Wishlist = require('../models/wishlist');
const User = require('../models/User');
const auth = require('../middleware/auth');
const role = require('../middleware/role');
const checkAuth = require('../utils/auth');
const { s3Upload } = require('../utils/storage');
const { getStoreProductsQuery, getStoreProductsWishListQuery } = require('../utils/queries');
const { ROLES, CATEGORIES, ENDPOINT } = require('../constants');
const NotificationService = require('../services/notificationService');

const storage = multer.memoryStorage();
// File filter function
const fileFilter = (req, file, cb) => {
	// Accept only specific file types (e.g., images and PDFs)
	if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/png') {
		cb(null, true);
	} else {
		cb(new Error('Invalid file type. Only JPEG and PNG files are allowed.'), false);
	}
};

// Multer configuration
const upload = multer({
	storage: storage,
	limits: {
		fileSize: 5 * 1024 * 1024 // Limit file size to 5MB
	},
	fileFilter: fileFilter
});
//complete
// fetch product slug api

router.get('/item/:slug', async (req, res) => {
	try {
		const slug = req.params.slug;

		// Check authentication and role
		const userDoc = await checkAuth(req);
		const userId = userDoc?.id;
		const isAdmin = userDoc?.role === ROLES.Admin;

		// Create filter based on user role
		const filter = { slug };
		if (!isAdmin) {
			filter.isActive = true; // Non-admin users can only see active products
		}

		// Fetch the product using the slug
		const productDoc = await Product.findOne(filter, { imageKey: 0 })
			.populate('user', '_id firstName lastName userId role accountType isActive avatar followers')
			.lean(); // Use lean() for better performance and to return plain JavaScript objects

		if (!productDoc || !productDoc.user || (!isAdmin && !productDoc.isActive)) {
			return res.status(404).json({
				error: 'No product found.'
			});
		}

		// Calculate the number of likes
		const totalLikes = productDoc.likes.length;

		// Check if the user liked the product
		const userLiked = userId ? productDoc.likes.includes(userId) : false;

		// Check if the authenticated user is following the product user
		const userIsFollowingProductUser = userId && productDoc.user.followers.includes(userId);

		// Check if the product has offers
		const isOffers = productDoc.offers && productDoc.offers.length > 0;

		// Check if the product is wishlisted by the user
		const isWishlisted = userId ? await Wishlist.exists({ user: userId, product: productDoc._id }) : false;

		// Add totalLikes, userLiked, userIsFollowing, isOffers, and isWishlisted to the product document
		const responseProduct = {
			...productDoc,
			totalLikes,
			userLiked,
			userIsFollowing: userIsFollowingProductUser,
			isOffers,
			isWishlisted
		};

		// Remove the likes array and followers from the response
		delete responseProduct.likes;
		delete responseProduct.user.followers;

		return res.status(200).json({ product: responseProduct });
	} catch (error) {
		console.error(error);
		res.status(500).json({
			error: 'Your request could not be processed. Please try again.'
		});
	}
});

// complete
// fetch product name search api

router.get('/list/search', async (req, res) => {
	const userDoc = await checkAuth(req);
	const userId = userDoc?.id;
	const isAdmin = userDoc?.role === ROLES.Admin;

	try {
		const { name, page = 1, limit = 10 } = req.query;
		const searchTerm = name ? name.trim() : '';

		// Create regex pattern for searching
		const regex = new RegExp(searchTerm, 'i');

		// Construct filter to search by name, description, category, and tags
		const filter = {
			$or: [{ name: regex }, { description: regex }, { category: regex }, { tags: { $in: [regex] } }]
		};

		// If the user is not an admin, add isActive filter
		if (!isAdmin) {
			filter.isActive = true;
		}

		// Fetch reported products for the logged-in user
		const reportedProducts = await Report.find({ itemType: 'Product', reportedBy: userId }).select('itemId').lean();
		const reportedProductIds = reportedProducts.map((report) => report.itemId.toString());

		// Exclude reported products from the filter
		if (reportedProductIds.length > 0) {
			filter._id = { $nin: reportedProductIds };
		}

		const skip = (page - 1) * limit;
		const projection = {
			_id: 1,
			sku: 1,
			name: 1,
			imageUrl: 1,
			description: 1,
			user: 1,
			isActive: 1,
			category: 1,
			tags: 1,
			likes: 1,
			offers: 1,
			createdAt: 1
		};

		// Fetch user wishlist once and store it in a Set for quick lookup
		const userWishlist = await Wishlist.findOne({ user: userId }).select('product').lean();
		const wishlistSet = new Set(userWishlist?.product.map((p) => p.toString()) || []);

		// Fetch products with the filter and projection
		const products = await Product.find(filter, projection)
			.populate('user', '_id firstName lastName userId role isActive avatar followers createdAt')
			.sort('-createdAt')
			.skip(skip)
			.limit(limit)
			.lean()
			.exec();

		if (products.length === 0) {
			return res.status(404).json({
				message: 'No product found.'
			});
		}

		// Count documents with the given filters
		const count = await Product.countDocuments(filter);

		// Check if the authenticated user liked each product and get the total likes
		const productsWithLikes = products.map((product) => {
			const userLiked = product.likes.includes(userId);
			const userIsFollowingProductUser = (product.user && product.user.followers.includes(userId)) || false;
			const isOffers = product.offers && product.offers.length > 0;
			const isWishlisted = wishlistSet.has(product._id.toString());

			return {
				_id: product._id,
				sku: product.sku,
				name: product.name,
				imageUrl: product.imageUrl,
				description: product.description,
				user: {
					_id: product.user._id,
					firstName: product.user.firstName,
					lastName: product.user.lastName,
					userId: product.user.userId,
					role: product.user.role,
					isActive: product.user.isActive,
					avatar: product.user.avatar,
					createdAt: product.user.createdAt
				},
				isActive: product.isActive,
				category: product.category,
				tags: product.tags,
				totalLikes: product.likes.length,
				userLiked,
				userIsFollowing: userIsFollowingProductUser,
				isOffers,
				isWishlisted,
				createdAt: product.createdAt
			};
		});

		res.status(200).json({
			products: productsWithLikes,
			totalPages: Math.ceil(count / limit),
			currentPage: Number(page),
			count
		});
	} catch (error) {
		console.error(error);
		res.status(500).json({
			error: 'Internal server error'
		});
	}
});



// fetch products api of particular user by admin

// fetch products api of particular user by admin

router.get('/list', async (req, res) => {
	const { page = 1, limit = 10, likes, category, isActive = true, sortDispatchDay, following } = req.query;
	const userDoc = await checkAuth(req); // Fetch the authenticated user document

	const userId = userDoc?.id;
	const isAdmin = userDoc?.role === ROLES.Admin;
            
	try {
		// Create a filter object based on query parameters
		let filter = {
			isActive: isAdmin && isActive === 'false' ? false : true
		};

		// Filter by category if provided
		if (category) {
			filter.category = { $in: category.split(',').map((cat) => cat.trim()) };
		}

		// Exclude rejected products and vendor products for merchants
		if (userDoc?.role === ROLES.Merchant) {
			const vendorAds = await Vendor.findOne({ user: userId }).select('products rejProducts').lean();
			filter._id = { $nin: [...vendorAds.products, ...vendorAds.rejProducts] }; // Assuming rejProducts is an array of rejected product IDs
		}

		// Filter products where the product's user is in the authenticated user's following list
		if (following && following.toLowerCase() === 'true') {
			const followingUsers = await User.findById(userId).select('following').lean();
			const followingUserIds = followingUsers?.following || [];
			filter.user = { $in: followingUserIds.length ? followingUserIds : [userId] };
		}

		// Fetch the user's wishlist once and use a Set for fast lookup
		const userWishlist = await Wishlist.findOne({ user: userId }).select('product').lean();
		const wishlistSet = new Set(userWishlist?.product.map((p) => p.toString()) || []);

		// Fetch reports by the logged-in user to exclude those products
		const userReports = await Report.find({ reportedBy: userId, itemType: 'Product' }).select('itemId').lean();
		const reportedProductIds = userReports.map((report) => report.itemId.toString());

		// Modify filter to exclude reported products
		filter._id = { $nin: reportedProductIds };

		// Base query to find products with the given filters
		let productsQuery = Product.find(filter)
			.select('_id sku imageUrl description user name isActive category dispatchDay slug createdAt offers likes')
			.populate({
				path: 'user',
				select: '_id firstName lastName userId role isActive avatar createdAt followers',
				options: { lean: true }
			})
			.lean()
			.limit(Number(limit))
			.skip((Number(page) - 1) * Number(limit));

		// Sort products based on likes, dispatchDay, or default by creation date
		if (likes) {
			productsQuery = productsQuery.sort({ likes: -1 });
		} else if (sortDispatchDay) {
			const sortOrder = sortDispatchDay.toLowerCase() === 'asc' ? 1 : -1;
			productsQuery = productsQuery.sort({ dispatchDay: sortOrder });
		} else {
			productsQuery = productsQuery.sort('-createdAt');
		}

		// Execute the product query and count query concurrently
		const [products, count] = await Promise.all([productsQuery.exec(), Product.countDocuments(filter)]);

		// Prepare the response with product details
		const productsWithLikes = products.map((product) => {
			const totalLikes = product.likes.length;
			const userLiked = product.likes.includes(userId);
			const userIsFollowingProductUser = product.user.followers.includes(userId);
			const isOffers = product.offers && product.offers.length > 0;
			const isWishlisted = wishlistSet.has(product._id.toString());

			return {
				_id: product._id,
				sku: product.sku,
				slug: product.slug,
				name: product.name,
				imageUrl: product.imageUrl,
				description: product.description,
				user: {
					_id: product.user._id,
					firstName: product.user.firstName,
					lastName: product.user.lastName,
					userId: product.user.userId,
					role: product.user.role,
					isActive: product.user.isActive,
					avatar: product.user.avatar,
					createdAt: product.user.createdAt
				},
				isActive: product.isActive,
				category: product.category,
				dispatchDay: product.dispatchDay,
				totalLikes,
				userLiked,
				userIsFollowing: userIsFollowingProductUser,
				createdAt: product.createdAt,
				isOffers,
				isWishlisted
			};
		});

		res.status(200).json({
			products: productsWithLikes,
			totalPages: Math.ceil(count / limit),
			currentPage: Number(page),
			count
		});
	} catch (error) {
		console.error(error);
		res.status(500).json({
			error: 'Internal server error'
		});
	}
});


//offerlist
router.get('/offers/list/:productId', async (req, res) => {
	const { page = 1, limit = 10, pricePerProduct, dispatchDay, standardDeliveryPrice, expediteDeliveryPrice } = req.query;

	try {
		// Check authentication and role
		const userDoc = await checkAuth(req);
		const isAdmin = userDoc?.role === ROLES.Admin;
		const productId = req.params.productId;

		// Construct query based on isAdmin status and productId
		const query = isAdmin ? { _id: productId } : { _id: productId, isActive: true };

		// Find the product based on productId and query conditions
		const product = await Product.findOne(query);

		if (!product) {
			return res.status(404).json({ error: 'Product not found' });
		}

		// Extract offers from the product
		let offers = product.offers;

		// Fetch vendor details for each offer asynchronously
		const offersWithVendorDetails = await Promise.all(
			offers.map(async (offer) => {
				const vendor = await Vendor.findById(offer.vendor).populate('user', 'avatar'); // Assuming vendor has a 'user' field

				return {
					vendorId: vendor.vendorId,
					vendorRating: vendor.rating,
					vendorAddress: vendor.merchantAddress,
					vendorIsActive: vendor.isActive,
					vendorAvatar: vendor.user.avatar,
					...offer.toObject() // Convert Mongoose document to plain JavaScript object
				};
			})
		);

		// Apply sorting based on pricePerProduct, dispatchDay, standardDeliveryPrice, and expediteDeliveryPrice
		if (pricePerProduct) {
			offersWithVendorDetails.sort((a, b) => {
				if (pricePerProduct === 'asc') {
					return a.pricePerProduct - b.pricePerProduct;
				} else if (pricePerProduct === 'desc') {
					return b.pricePerProduct - a.pricePerProduct;
				}
				return 0;
			});
		}

		if (dispatchDay) {
			offersWithVendorDetails.sort((a, b) => {
				if (dispatchDay === 'asc') {
					return a.dispatchDay - b.dispatchDay;
				} else if (dispatchDay === 'desc') {
					return b.dispatchDay - a.dispatchDay;
				}
				return 0;
			});
		}

		if (standardDeliveryPrice) {
			offersWithVendorDetails.sort((a, b) => {
				if (standardDeliveryPrice === 'asc') {
					return a.standardDeliveryPrice - b.standardDeliveryPrice;
				} else if (standardDeliveryPrice === 'desc') {
					return b.standardDeliveryPrice - a.standardDeliveryPrice;
				}
				return 0;
			});
		}

		if (expediteDeliveryPrice) {
			offersWithVendorDetails.sort((a, b) => {
				if (expediteDeliveryPrice === 'asc') {
					return a.expediteDeliveryPrice - b.expediteDeliveryPrice;
				} else if (expediteDeliveryPrice === 'desc') {
					return b.expediteDeliveryPrice - a.expediteDeliveryPrice;
				}
				return 0;
			});
		}

		// Pagination logic
		const startIndex = (page - 1) * limit;
		const paginatedOffers = offersWithVendorDetails.slice(startIndex, startIndex + limit);

		res.json({
			totalOffers: offersWithVendorDetails.length,
			currentPage: parseInt(page, 10),
			offers: paginatedOffers
		});
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal server error' });
	}
});


// add product api
router.post('/add', auth, upload.single('image'), async (req, res) => {
	try {

		const { sku, name, description, tags, link, category, dispatchDay,  } = req.body;
		const userId = req.user._id;
		const image = req.file;

		// Validate user
		const findUser = await User.findById(userId).populate({ path: 'followers', select: 'userId firstName avatar' });

		if (!findUser) {
			return res.status(404).json({ error: 'User not found' });
		}

		// Validate required fields
		if (!sku) {
			return res.status(400).json({ error: 'You must enter a SKU.' });
		}

		if (!name) {
			return res.status(400).json({ error: 'You must enter name.' });
		}

		if (!dispatchDay) {
			return res.status(400).json({ error: 'You must enter dispatch days.' });
		}

		// Validate categories
		const categoriesArray = Array.isArray(category) ? category : category.split(',').map((cat) => cat.trim());
		for (const cat of categoriesArray) {
			if (!Object.values(CATEGORIES).includes(cat)) {
				return res.status(404).json({ error: `No such category available: ${cat}` });
			}
		}

		// Check if SKU is unique
		const foundProduct = await Product.findOne({ sku });

		if (foundProduct) {
			return res.status(400).json({ error: 'This SKU is already in use.' });
		}

		// Upload image to S3
		const { imageUrl, imageKey } = await s3Upload(image);

		// Create product data
		const data = {
			sku,
			name,
			description,
			category: categoriesArray,
			user: findUser._id,
			imageUrl,
			imageKey,
			tags: Array.isArray(tags) ? tags : tags.split(',').map((tag) => tag.trim()),
			link,
			dispatchDay
		};

		// Save product to the database
		const product = new Product(data);
		const savedProduct = await product.save();
		findUser.posts.push(savedProduct);
		findUser.save();

		// Notify followers
		for (const follower of findUser.followers) {
			const notificationData = {
				userId: follower._id,
				title: follower.userId,
				avatar: follower.avatar,
				message: `uploaded a new post`,
				url: `${ENDPOINT.Product}${savedProduct._id}`,
				imgUrl: savedProduct.imageUrl
			};
			await NotificationService.createNotification(notificationData);
		}

		// Construct the response object with the required fields
		const responseProduct = {
			_id: savedProduct._id,
			sku: savedProduct.sku,
			name: savedProduct.name,
			imageUrl: savedProduct.imageUrl,
			description: savedProduct.description,
			isActive: savedProduct.isActive,
			tags: savedProduct.tags,
			link: savedProduct.link,
			slug: savedProduct.slug,
			category: savedProduct.category
		};

		res.status(200).json({
			success: true,
			message: `Product has been added successfully!`,
			product: responseProduct
		});
	} catch (error) {
		console.error(error);
		return res.status(400).json({
			error: 'Your request could not be processed. Please try again.'
		});
	}
});

// fetch products api of particular user
router.get('/', auth, async (req, res) => {
	const { page = 1, limit = 10 } = req.query;
	const userId = req.user._id;

	try {
		// Pagination and projection
		const skip = (page - 1) * limit;
		const projection = { imageKey: 0, likes: 0 }; // Exclude likes and imageKey from initial query

		// Fetch products with pagination
		const products = await Product.find({ user: userId }, projection)
			.sort('-createdAt')
			.skip(skip)
			.limit(limit)
			.lean() // Use lean for better performance
			.exec();

		if (!products.length) {
			return res.status(404).json({ message: 'No products found.' });
		}

		// Get total product count for pagination
		const count = await Product.countDocuments({ user: userId });

		// Fetch wishlisted product IDs
		const wishlistedProductIds = userId ? await Wishlist.find({ user: userId }).distinct('product') : [];

		// Convert wishlistedProductIds to strings
		const wishlistedProductIdsStr = wishlistedProductIds.map((id) => id.toString());

		// Check if each product is wishlisted and if it has offers
		const productsWithAdditionalInfo = products.map((product) => {
			// Ensure likes is an array
			const likes = product.likes || [];
			const totalLikes = likes.length;
			const userLiked = userId ? likes.includes(userId) : false;
			const isOffers = product.offers && product.offers.length > 0;
			const isWishlisted = wishlistedProductIdsStr.includes(product._id.toString());

			return {
				...product,
				totalLikes,
				userLiked,
				isOffers,
				isWishlisted
			};
		});

		res.status(200).json({
			products: productsWithAdditionalInfo,
			totalPages: Math.ceil(count / limit),
			currentPage: Number(page),
			count
		});
	} catch (error) {
		console.error(error);
		res.status(500).json({
			error: 'Internal server error'
		});
	}
});


// fetch product api of particular product by it's Id

router.get('/:id', async (req, res) => {
	try {
		const productId = req.params.id;

		// Check authentication and role
		const userDoc = await checkAuth(req);
		const userId = userDoc?.id;
		const isAdmin = userDoc?.role === ROLES.Admin;

		// Create filter based on user role
		const filter = { _id: productId };
		if (!isAdmin) {
			filter.isActive = true; // Non-admin users can only see active products
		}

		// Fetch the product and project the necessary fields
		const productDoc = await Product.findOne(filter, { imageKey: 0 })
			.populate({
				path: 'user',
				select: '_id firstName lastName userId role accountType isActive avatar followers'
			})
			.lean(); // Use lean() for better performance and to return plain JavaScript objects

		if (!productDoc) {
			return res.status(404).json({
				error: 'No data found'
			});
		}

		// Calculate the number of likes
		const totalLikes = productDoc.likes.length;

		// Check if the user liked the product
		const userLiked = userId ? productDoc.likes.includes(userId) : false;

		// Check if the authenticated user is following the product user
		const userIsFollowingProductUser = productDoc.user.followers.some((follower) => follower.equals(userId));

		// Add totalLikes, userLiked, and userIsFollowing to the product document
		productDoc.totalLikes = totalLikes;
		productDoc.userLiked = userLiked;
		productDoc.userIsFollowing = userIsFollowingProductUser;

		// Remove the likes array and followers from the response
		delete productDoc.likes;
		delete productDoc.user.followers;

		return res.status(200).json({ product: productDoc });
	} catch (error) {
		console.error(error);
		res.status(500).json({
			error: 'Your request could not be processed. Please try again.'
		});
	}
});

// completed

// Update product by Id (user and Admin)
router.put('/:id', auth, async (req, res) => {
	try {
		const productId = req.params.id;
		const userId = req.user._id;
		const userRole = req.user.role;
		const { sku, slug, description, tags, category, link } = req.body;

		// Find the product to check ownership
		const product = await Product.findById(productId);
		if (!product) {
			return res.status(404).json({
				error: 'Product not found.'
			});
		}

		// Check if the requester is the owner of the product or an admin
		if (String(product.user) !== String(userId) && userRole !== ROLES.Admin) {
			return res.status(403).json({
				error: 'You do not have permission to update this product.'
			});
		}

		// Check if SKU or slug is already in use by another product
		const foundProduct = await Product.findOne({
			$or: [{ slug }, { sku }],
			_id: { $ne: productId } // Exclude the current product being updated
		});

		if (foundProduct) {
			return res.status(400).json({ error: 'SKU or slug is already in use.' });
		}

		// Filter the update object to allow only specific fields and non-empty values
		const updateFields = { sku, slug, description, tags, category, link };
		const allowedUpdates = {};
		Object.keys(updateFields).forEach((key) => {
			if (updateFields[key] !== undefined && updateFields[key].length > 0) {
				allowedUpdates[key] = updateFields[key];
			}
		});

		// Validate category if provided
		if (allowedUpdates.category) {
			const categoriesArray = Array.isArray(allowedUpdates.category)
				? allowedUpdates.category
				: allowedUpdates.category.split(',').map((cat) => cat.trim());
			for (const cat of categoriesArray) {
				if (!Object.values(CATEGORIES).includes(cat)) {
					return res.status(400).json({ error: `Invalid category: ${cat}` });
				}
			}
			allowedUpdates.category = categoriesArray; // Assign the validated array back to update
		}

		// Update the product
		const updatedProduct = await Product.findByIdAndUpdate(productId, allowedUpdates, {
			new: true
		});
		const data = {
			_id: updatedProduct._id,
			sku: updatedProduct.sku,
			name: updatedProduct.name,
			imageUrl: updatedProduct.imageUrl,
			description: updatedProduct.description,
			isActive: updatedProduct.isActive,
			tags: updatedProduct.tags,
			category: updatedProduct.category,
			link: updatedProduct.link,
			slug: updatedProduct.slug,
			createdAt: updatedProduct.createdAt
		};

		res.status(200).json({
			success: true,
			message: 'Product has been updated successfully!',
			product: data
		});
	} catch (error) {
		console.log(error);
		res.status(400).json({
			error: 'Your request could not be processed. Please try again.'
		});
	}
});

router.put('/:id/active', auth, async (req, res) => {
	try {
		const productId = req.params.id;
		const userId = req.user._id;
		const userRole = req.user.role;
		const isActive = req.body.isActive; // Ensure isActive is defined

		if (isActive === undefined) {
			return res.status(400).json({ error: 'isActive field is missing in the request body.' });
		}

		// Find the product to check ownership
		const product = await Product.findById(productId);
		if (!product) {
			return res.status(404).json({ error: 'Product not found.' });
		}

		// Check if the requester is the owner of the product or an admin
		if (String(product.user) !== String(userId) && userRole !== ROLES.Admin) {
			return res.status(403).json({ error: 'You do not have permission to update this product.' });
		}

		// Update the product's isActive status
		product.isActive = isActive;
		await product.save();

		// Create notification data
		const notificationData = {
			userId: product.user,
			title: product.name,
			message: `Your Product is now ${isActive ? 'Active' : 'Inactive'}`,
			url: `${ENDPOINT.Product}${product._id}`,
			imgUrl: product.imageUrl || ''
		};

		// Send notification
		const notification = await NotificationService.createNotification(notificationData);

		res.status(200).json({
			success: true,
			message: 'Product has been updated successfully!',
			isActive: product.isActive
		});
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'An internal server error occurred. Please try again later.' });
	}
});

//completed
//delete product by Id (Admin & User)
router.delete('/delete/:id', auth, async (req, res) => {
	try {
		const productId = req.params.id;
		const userId = req.user._id;
		const userRole = req.user.role;

		// Find the product to get the user ID before deletion
		const product = await Product.findById(productId);
		if (!product) {
			return res.status(404).json({
				error: 'Product not found.'
			});
		}

		// Check if the requester is the owner of the product or an admin
		if (String(product.user) !== String(userId) && userRole !== ROLES.Admin) {
			return res.status(403).json({
				error: 'You do not have permission to delete this product.'
			});
		}

		// Delete the product
		await Product.deleteOne({ _id: productId });

		// Remove the product from the user's posts array
		await User.updateOne({ _id: product.user }, { $pull: { posts: productId } });

		res.status(200).json({
			success: true,
			message: `Product has been deleted successfully!`
		});
	} catch (error) {
		console.error(error);
		res.status(400).json({
			error: 'Your request could not be processed. Please try again.'
		});
	}
});

router.put('/like/:productId', auth, async (req, res) => {
	try {
		const { productId } = req.params;
		const userId = req.user._id;

		const product = await Product.findById(productId);
		const findUser = await User.findById(userId);

		if (!findUser) {
			res.status(404).json({ error: 'User not found' });
		}

		if (!product) {
			return res.status(404).json({
				success: false,
				message: 'Product not found!'
			});
		}

		const likeIndex = product.likes.indexOf(userId);
		let message;

		if (likeIndex === -1) {
			// User has not liked the product, so like it
			product.likes.push(userId);
			message = 'Product liked successfully!';
			const notificationData = {
				userId: product.user,
				title: findUser.userId,
				avatar: findUser.avatar || '',
				message: `liked your post`,
				url: `${ENDPOINT.Product}${product._id}`,
				imgUrl: product.imageUrl || ''
			};
			console.log(notificationData);
			const notification = await NotificationService.createNotification(notificationData);
		} else {
			// User has already liked the product, so dislike it
			product.likes.pull(userId);
			message = 'Product disliked successfully!';
		}

		await product.save();

		res.status(200).json({
			success: true,
			message,
			likes: product.likes.length
		});
	} catch (error) {
		console.error(error);
		res.status(500).json({
			success: false,
			error: 'An internal server error occurred. Please try again later.'
		});
	}
});

router.get('/likeslist/:productId', auth, async (req, res) => {
	try {
		const { productId } = req.params;
		const userId = req.user._id;

		// Find the product
		const product = await Product.findOne({ _id: productId, isActive: true }).populate(
			'likes',
			'_id userId firstName lastName avatar'
		);

		if (!product) {
			return res.status(404).json({
				error: 'Product not found.'
			});
		}

		// Get the list of users who liked the product
		const usersWhoLiked = product.likes;

		// Check if the request user is following each user who liked the product
		const usersWithFollowStatus = await Promise.all(
			usersWhoLiked.map(async (user) => {
				// Check if the request user is following this user
				const isFollowing = await User.exists({ _id: userId, following: user._id });
				return {
					_id: user._id,
					userId: user.userId,
					firstName: user.firstName,
					lastName: user.lastName,
					avatar: user.avatar,
					isFollowing: isFollowing ? true : false
				};
			})
		);

		res.status(200).json({
			success: true,
			usersWhoLiked: usersWithFollowStatus
		});
	} catch (error) {
		console.error(error);
		res.status(500).json({
			success: false,
			error: 'An internal server error occurred. Please try again later.'
		});
	}
});

// accept ads by vendor
router.post('/vendor/:productId/accept', auth, role.check(ROLES.Merchant), async (req, res) => {
	try {
		const { pricePerProduct, dispatchDay, remark, material, description, standardDeliveryPrice, expediteDeliveryPrice } =
			req.body;
		if (!pricePerProduct || !dispatchDay || !remark || !material || !description || !standardDeliveryPrice || !expediteDeliveryPrice) {
			return res.status(401).json({ error: 'All fiels are required' });
		}
		const productId = req.params.productId;
		const vendorId = req.user.vendor;

		// Check if the ad exists
		const product = await Product.findOne({ _id: productId, isActive: true });
		if (!product) {
			return res.status(404).json({ error: 'Ad not found' });
		}

		// Check if the vendor exists
		const vendor = await Vendor.findById(vendorId).populate('user', 'avatar, firstName');
		if (!vendor) {
			return res.status(404).json({ error: 'Vendor not found' });
		}

		// Check if the vendor is already associated with the ad

		if (vendor.products.includes(productId)) {
			return res.status(400).json({ error: 'Vendor already accepted product' });
		}

		const vendorDetails = {
			pricePerProduct,
			dispatchDay,
			remark,
			vendor: vendor._id,
			material,
			description,
			standardDeliveryPrice,
			expediteDeliveryPrice
		};
		// Add the vendor to the ad's offers array
		product.offers.push(vendorDetails);
		vendor.products.push(productId);

		// Save the updated ad and vendor documents
		const productDoc = await product.save();
		await vendor.save();
		const result = {
			productDetails: {
				name: productDoc.name,
				imageUrl: productDoc.imageUrl,
				description: productDoc.description,
				tags: productDoc.tags,
				category: productDoc.category,
				dispatchDay: productDoc.dispatchDay
			},

			newOffer: {
				vendorRating: vendor.rating,
				vendorLocation: vendor.merchantAddress,
				...vendorDetails
			}
		};

		//Notification to user
		const notificationData = {
			userId: productDoc.user,
			title: vendor.user.firstName,
			avatar: vendor.user.avatar || '',
			message: `accept your product at price ₹${pricePerProduct} per Product`,
			url: `${ENDPOINT.UserProfile}${vendor.user._id}`,
			imgUrl: productDoc.imageUrl || ''
		};
		const notification = await NotificationService.createNotification(notificationData);

		res.json({ success: true, message: 'Successfully added ad', result });
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

// cancel product by vendor accepted product ad
router.put('/vendor/:productId/cancel', auth, role.check(ROLES.Merchant), async (req, res) => {
	try {
		const productId = req.params.productId;
		const vendorId = req.user.vendor;

		// Check if the ad exists
		const product = await Product.findById(productId);
		if (!product) {
			return res.status(404).json({ error: 'Product not found' });
		}

		// Check if the vendor exists
		const vendor = await Vendor.findById(vendorId);
		if (!vendor) {
			return res.status(404).json({ error: 'Vendor not found' });
		}

		// Check if the vendor has already accepted the ad
		const offerIndex = product.offers.findIndex((offer) => offer.vendor.toString() === vendorId.toString());
		if (offerIndex === -1) {
			return res.status(400).json({ error: 'Vendor yet not accept the ad of Product' });
		}

		// Remove the offer from the ad's offers array
		product.offers.splice(offerIndex, 1);
		vendor.products.pull(productId);

		// Save the updated ad and vendor documents
		const productDoc = await product.save();
		await vendor.save();

		res.json({ success: true, message: 'Successfully cancelled ad of product' });
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

// reject ads of product by vendor
router.post('/vendor/:productId/reject', auth, role.check(ROLES.Merchant), async (req, res) => {
	try {
		const productId = req.params.productId;
		const vendorId = req.user.vendor;

		// Check if the ad exists
		const product = await Product.findById(productId);
		if (!product) {
			return res.status(404).json({ error: 'product not found' });
		}

		// Check if the vendor exists
		const vendor = await Vendor.findById(vendorId);
		if (!vendor) {
			return res.status(404).json({ error: 'Vendor not found' });
		}

		// Check if the vendor is already associated with the ad
		if (vendor.products.includes(productId)) {
			return res.status(400).json({ error: 'Vendor already accept the ad' });
		}

		// Check if the vendor is already associated with the ad
		if (vendor.rejProducts.includes(productId)) {
			return res.status(400).json({ error: 'Vendor already reject the ad' });
		}

		vendor.rejProducts.push(productId);

		await vendor.save();

		res.json({ success: true, message: 'Successfully rejected product' });
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

// Get all accepted and rejected offers for a vendor
router.get('/vendor/myoffer/status', auth, role.check(ROLES.Merchant), async (req, res) => {
	try {
		const vendorId = req.user.vendor;
		const { status = 'accepted', page = 1, limit = 10 } = req.query;

		// Check if the vendor exists
		const vendor = await Vendor.findById(vendorId);
		if (!vendor) {
			return res.status(404).json({ error: 'Vendor not found' });
		}

		let products;
		if (status === 'accepted') {
			products = vendor.products;
		} else if (status === 'rejected') {
			products = vendor.rejProducts;
		} else {
			return res.status(400).json({ error: 'Invalid status' });
		}

		// Pagination
		const totalProducts = products.length;
		const startIndex = (page - 1) * limit;
		const endIndex = page * limit;
		const paginatedProducts = products.slice(startIndex, endIndex);

		const projection = {
			_id: 1,
			name: 1,
			imageUrl: 1,
			description: 1,
			category: 1,
			dispatchDay: 1
		};
		// Fetch detailed ad information for each ad ID in the paginated list
		const productsDetails = await Product.find({ _id: { $in: paginatedProducts } }, projection)
			.populate('user', '_id firstName userId isActive avatar role')
			// .populate('address', '_id city')
			.exec();
		// .populate('product', '_id sku name imageUrl description isActive category')

		res.json({
			products: productsDetails,
			totalPages: Math.ceil(totalProducts / limit),
			currentPage: Number(page),
			count: totalProducts
		});
	} catch (error) {
		console.error(error);
		res.status(500).json({ error: 'Internal server error' });
	}
});

module.exports = router;
