import { createTheme, type MantineColorsTuple } from '@mantine/core';

const brand: MantineColorsTuple = [
  '#fff0ef',
  '#ffdcd9',
  '#fdb5af',
  '#fb8a81',
  '#f8665b',
  '#f64f42',
  '#ef3124',
  '#d42619',
  '#bd1f13',
  '#a3150a',
];

const font = "'Manrope Variable', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export const theme = createTheme({
  primaryColor: 'brand',
  primaryShade: 6,
  colors: { brand },
  fontFamily: font,
  headings: { fontFamily: font, fontWeight: '800' },
  defaultRadius: 'md',
  radius: { sm: '8px', md: '12px', lg: '18px', xl: '28px' },
  shadows: {
    xs: '0 1px 2px rgba(17, 24, 39, 0.04), 0 1px 1px rgba(17, 24, 39, 0.03)',
    sm: '0 4px 14px rgba(17, 24, 39, 0.06)',
    md: '0 12px 32px rgba(17, 24, 39, 0.08)',
  },
  components: {
    Card: { defaultProps: { radius: 'lg', padding: 'lg', shadow: 'xs' } },
    Paper: { defaultProps: { radius: 'lg' } },
    Button: { defaultProps: { radius: 'md' } },
    Badge: { defaultProps: { radius: 'sm' } },
  },
});

export const BRAND = {
  name: 'Поток',
  caption: 'Кредиты для бизнеса',
};
