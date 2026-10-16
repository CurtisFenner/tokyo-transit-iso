import { defineConfig } from 'vite'

export default defineConfig({
	build: {
		rollupOptions: {
			input: ["index.html"],
		},
	},
	base: "/tokyo-transit-iso/",
})
