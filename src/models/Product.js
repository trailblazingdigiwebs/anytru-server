const mongoose = require('mongoose');
const { CATEGORIES } = require('../constants/index');
const slug = require('mongoose-slug-updater');
const { Schema } = mongoose;

const options = {
	separator: '-',
	lang: 'en',
	truncate: 120
};

mongoose.plugin(slug, options);

// Product Schema
const ProductSchema = new Schema(
	{
		sku: {
			type: String
		},
		name: {
			type: String,
			trim: true
		},
		slug: {
			type: String,
			slug: 'name',
			unique: true
		},
		imageUrl: {
			type: String
		},
		imageKey: {
			type: String
		},
		description: {
			type: String,
			trim: true
		},

		isActive: {
			type: Boolean,
			default: false
		},

		user: {
			type: Schema.Types.ObjectId,
			ref: 'User',
			default: null
		},
		tags: [
			{
				type: String
			}
		],
		category: [
			{
				type: String,
				default: CATEGORIES.Others,
				enum: [
					CATEGORIES.Others,
					CATEGORIES.Accessories,
					CATEGORIES.Clothing,
					CATEGORIES.EventSetups,
					CATEGORIES.Furniture,
					CATEGORIES.HomeDecor,
					CATEGORIES.Jewellery,
					CATEGORIES.PrintsGraphics
				]
			}
		],
		likes: [
			{
				type: Schema.Types.ObjectId,
				ref: 'User'
			}
		],
		link: String,

		dispatchDay: {
			type: Number
		},
		// updated: Date,
		// created: {
		// 	type: Date,
		// 	default: Date.now
		// }
		offers: [
			{
				vendor: {
					type: mongoose.Schema.Types.ObjectId,
					ref: 'Vendor'
				},
				pricePerProduct: {
					type: Number
				},
				dispatchDay: {
					type: Number
				},
				remark: {
					type: String,
					trim: true
				},
				material: {
					type: String,
					trim: true
				},
				description: {
					type: String,
					trim: true
				},
				standardDeliveryPrice: {
					type: Number,
					required: true,
					default: 0
				},
				expediteDeliveryPrice: {
					type: Number,
					required: true,
					default: 0
				}
			}
		]
	},
	{ timestamps: true }
);

// Error handling for slug generation
ProductSchema.post('save', function (error, doc, next) {
	if (error.name === 'MongoError' && error.code === 11000) {
		next(new Error('Slug must be unique.'));
	} else {
		next(error);
	}
});
const Product = mongoose.model('Product', ProductSchema);
module.exports = Product;
