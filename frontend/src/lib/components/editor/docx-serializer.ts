// @ts-nocheck
import {
	AlignmentType,
	HeadingLevel,
	Paragraph,
	Table,
	TableCell,
	TableRow,
	TextRun,
} from "docx";
import {
	DocxSerializer,
	DocxSerializerAsync,
	defaultAsyncNodes,
	defaultMarks,
	defaultNodes,
	MAX_IMAGE_WIDTH,
} from "prosemirror-docx";

/**
 * Resolve TipTap paragraph/heading textAlign attribute to docx alignment.
 */
function getAlignment(node) {
	const align = node?.attrs?.textAlign;
	if (align === "center") return AlignmentType.CENTER;
	if (align === "right") return AlignmentType.RIGHT;
	if (align === "justify") return AlignmentType.BOTH;
	if (align === "left") return AlignmentType.LEFT;
	return undefined;
}

function getHeadingLevel(node) {
	const level = node?.attrs?.level ?? 1;
	const clampedLevel = Math.min(Math.max(level, 1), 6);
	return [
		HeadingLevel.HEADING_1,
		HeadingLevel.HEADING_2,
		HeadingLevel.HEADING_3,
		HeadingLevel.HEADING_4,
		HeadingLevel.HEADING_5,
		HeadingLevel.HEADING_6,
	][clampedLevel - 1];
}

export const customNodes = {
	...defaultNodes,
	horizontalRule: defaultNodes.horizontal_rule,
	hardBreak: defaultNodes.hard_break,
	codeBlock: defaultNodes.code_block,
	orderedList: defaultNodes.ordered_list,
	bulletList: defaultNodes.bullet_list,
	listItem: defaultNodes.list_item,

	// Paragraph & Heading with TextAlign attributes support
	paragraph(state, node) {
		state.renderInline(node);
		const alignment = getAlignment(node);
		state.closeBlock(node, alignment ? { alignment } : {});
	},
	heading(state, node) {
		state.renderInline(node);
		const heading = getHeadingLevel(node);
		const alignment = getAlignment(node);
		state.closeBlock(node, alignment ? { heading, alignment } : { heading });
	},

	// Task list support
	taskList: defaultNodes.bullet_list,
	taskItem(state, node) {
		const isChecked = node?.attrs?.checked ?? false;
		const checkboxChar = isChecked ? "☑ " : "☐ ";
		state.addParagraphOptions({});
		state.current.push(new TextRun({ text: checkboxChar }));
		state.renderContent(node);
	},

	// Tables layout support
	table(state, node) {
		const actualChildren = state.children;
		const rows = [];
		node.content.forEach((row) => {
			const cells = [];
			let isHeaderRow = true;
			row.content.forEach((cell) => {
				if (
					cell.type.name !== "tableHeader" &&
					cell.type.name !== "table_header"
				) {
					isHeaderRow = false;
				}
			});
			state.maxImageWidth = MAX_IMAGE_WIDTH / (row.content.childCount || 1);
			row.content.forEach((cell) => {
				const oldChildren = state.children;
				state.children = [];
				state.renderContent(cell);
				const tableCellOpts = { children: state.children };
				const colspan = cell.attrs.colspan ?? 1;
				const rowspan = cell.attrs.rowspan ?? 1;
				if (colspan > 1) tableCellOpts.columnSpan = colspan;
				if (rowspan > 1) tableCellOpts.rowSpan = rowspan;
				cells.push(new TableCell(tableCellOpts));
				state.children = oldChildren;
			});
			rows.push(new TableRow({ children: cells, tableHeader: isHeaderRow }));
		});
		state.maxImageWidth = MAX_IMAGE_WIDTH;
		const table = new Table({ rows });
		actualChildren.push(table);
		actualChildren.push(new Paragraph(""));
		state.children = actualChildren;
	},
	tableRow: () => {},
	tableCell: () => {},
	tableHeader: () => {},
};

export const customAsyncNodes = {
	...defaultAsyncNodes,
	horizontalRule: defaultAsyncNodes.horizontal_rule,
	hardBreak: defaultAsyncNodes.hard_break,
	codeBlock: defaultAsyncNodes.code_block,
	orderedList: defaultAsyncNodes.ordered_list,
	bulletList: defaultAsyncNodes.bullet_list,
	listItem: defaultAsyncNodes.list_item,

	async paragraph(state, node) {
		await state.renderInline(node);
		const alignment = getAlignment(node);
		state.closeBlock(node, alignment ? { alignment } : {});
	},
	async heading(state, node) {
		await state.renderInline(node);
		const heading = getHeadingLevel(node);
		const alignment = getAlignment(node);
		state.closeBlock(node, alignment ? { heading, alignment } : { heading });
	},
	async taskItem(state, node) {
		const isChecked = node?.attrs?.checked ?? false;
		const checkboxChar = isChecked ? "☑ " : "☐ ";
		state.addParagraphOptions({});
		state.current.push(new TextRun({ text: checkboxChar }));
		await state.renderContent(node);
	},
	async table(state, node) {
		const actualChildren = state.children;
		const rows = [];
		for (let rowIndex = 0; rowIndex < node.content.childCount; rowIndex += 1) {
			const row = node.content.child(rowIndex);
			const cells = [];
			let isHeaderRow = true;
			row.content.forEach((cell) => {
				if (
					cell.type.name !== "tableHeader" &&
					cell.type.name !== "table_header"
				) {
					isHeaderRow = false;
				}
			});
			state.maxImageWidth = MAX_IMAGE_WIDTH / (row.content.childCount || 1);
			for (
				let cellIndex = 0;
				cellIndex < row.content.childCount;
				cellIndex += 1
			) {
				const cell = row.content.child(cellIndex);
				const oldChildren = state.children;
				state.children = [];
				await state.renderContent(cell);
				const tableCellOpts = { children: state.children };
				const colspan = cell.attrs.colspan ?? 1;
				const rowspan = cell.attrs.rowspan ?? 1;
				if (colspan > 1) tableCellOpts.columnSpan = colspan;
				if (rowspan > 1) tableCellOpts.rowSpan = rowspan;
				cells.push(new TableCell(tableCellOpts));
				state.children = oldChildren;
			}
			rows.push(new TableRow({ children: cells, tableHeader: isHeaderRow }));
		}
		state.maxImageWidth = MAX_IMAGE_WIDTH;
		const table = new Table({ rows });
		actualChildren.push(table);
		actualChildren.push(new Paragraph(""));
		state.children = actualChildren;
	},
	tableRow: async () => {},
	tableCell: async () => {},
	tableHeader: async () => {},
};

export const customMarks = {
	...defaultMarks,
	strike: defaultMarks.strikethrough,
	highlight: (_state, mark) => {
		return { highlight: mark.attrs?.color || "yellow" };
	},
};

export const customSerializer = new DocxSerializer(customNodes, customMarks);
export const customSerializerAsync = new DocxSerializerAsync(
	customAsyncNodes,
	customMarks,
);
