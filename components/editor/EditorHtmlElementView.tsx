import { Fragment, createElement, type ReactNode } from "react";

type HtmlElementPayload = {
  attributes?: Record<string, string>;
  children?: unknown[];
  tag?: string;
  text?: string;
};

type EditorHtmlElementViewProps = {
  element: unknown;
};

const isHtmlElementPayload = (value: unknown): value is HtmlElementPayload => {
  return Boolean(value && typeof value === "object" && "tag" in value);
};

const renderHtmlElementPayload = (element: unknown): ReactNode => {
  if (!isHtmlElementPayload(element) || !element.tag) {
    return String(element ?? "");
  }

  const attributes = Object.fromEntries(
    Object.entries(element.attributes || {}).filter(([attr]) => !attr.startsWith("on"))
  );
  const children = [
    element.text,
    ...(element.children || []).map((child, index) => (
      <Fragment key={index}>{renderHtmlElementPayload(child)}</Fragment>
    ))
  ].filter((child) => child !== undefined && child !== null && child !== "");

  return createElement(element.tag, attributes, children);
};

export const EditorHtmlElementView = ({ element }: EditorHtmlElementViewProps) => {
  return <Fragment>{renderHtmlElementPayload(element)}</Fragment>;
};
