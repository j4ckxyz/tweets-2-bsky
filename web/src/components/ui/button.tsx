import { type VariantProps, cva } from 'class-variance-authority';
import * as React from 'react';
import { cn } from '../../lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-[background-color,color,border-color,transform] duration-150 ease-out active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        outline: 'border border-input bg-card text-foreground hover:border-foreground/25 hover:bg-muted',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        destructive: 'bg-late text-background hover:bg-late/90',
        subtle: 'bg-muted text-foreground hover:bg-muted/70',
      },
      size: {
        default: 'h-10 px-4 py-2',
        sm: 'h-8 rounded-md px-3 text-[13px]',
        lg: 'h-11 rounded-md px-8',
        icon: 'h-8 w-8',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  /**
   * Render the child element with the button's styling instead of a <button>.
   * Used for links that should look like buttons: nesting an <a> inside a
   * <button> is invalid HTML and loses the link's keyboard and context-menu
   * behaviour.
   */
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, type, asChild, children, ...props }, ref) => {
    const styles = cn(buttonVariants({ variant, size, className }));

    // Only DOM elements are cloned: forwarding a ref and button props into a
    // component that may not accept either is how asChild turns into a runtime
    // warning rather than a link that looks like a button.
    if (asChild && React.isValidElement(children) && typeof children.type === 'string') {
      const child = children as React.ReactElement<{ className?: string }>;
      return React.cloneElement(child, {
        ...props,
        ...child.props,
        className: cn(styles, child.props.className),
        ref,
      } as React.Attributes);
    }

    return (
      <button className={styles} ref={ref} type={type ?? 'button'} {...props}>
        {children}
      </button>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
