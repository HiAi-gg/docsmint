import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import StarterKit from "@tiptap/starter-kit";

export const editorExtensions = [
	StarterKit.configure({
		heading: { levels: [1, 2, 3] },
		codeBlock: false,
		link: false,
	}),
	Link.configure({ openOnClick: false }),
	Image.configure({ inline: false, allowBase64: false }),
	Highlight.configure({ multicolor: true }),
];
